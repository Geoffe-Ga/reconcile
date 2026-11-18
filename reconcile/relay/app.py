"""The relay's HTTP API: a blind mailbox (ADR-0019, ADR-0028, ADR-0073).

Clients append opaque, padded blobs to a mailbox and read them back in order.
The unguessable 43-character mailbox id is the only capability: there are no
accounts and no tokens.

Ordering and time. Run one Uvicorn worker: the handlers are ``async`` and call
SQLite synchronously, so no two of them touch the store at once. Two rules
keep the receipt minutes honest, which #63's deadline rule relies on:

- A GET reads the clock before it selects, so every record it leaves out
  has ``received`` >= the ``now`` it returns.
- A PUT stamps its record with a clock read taken only after its whole body
  has arrived, with no ``await`` between that and the insert, so a slow
  upload can't be stamped earlier than a GET that ran while it was still
  arriving.

Storage caps. A blob PUT gets 507 ``storage_full`` once the database and its
WAL pass ``max_db_bytes``, and 507 ``mailbox_full`` when it would take its
mailbox's unexpired blobs past ``max_mailbox_bytes`` (#141). Both are checked
on the declared length, before the body is read. The mailbox cap is checked
again just before the insert, with no ``await`` between, so uploads that were
in flight together can't carry a mailbox past it.

Backups (#97, ADR-0043 §3). ``PUT /v1/backup/{id}`` keeps one padded blob of
64 KiB, 256 KiB, 1 MiB, 4 MiB or 16 MiB under a 43-character id, replacing
any earlier one, until 180 days after the UTC day of the write; ``GET``
returns its bytes. The id follows the mailbox rule, the length is checked
before the body is read, and the relay's storage cap applies. The mailbox cap
counts blobs only.

Push (#89, ``reconcile.relay.push``). With a VAPID key set, devices register
push endpoints and schedule nudges under ``/v1/push/``, a blob PUT with
``wake=1`` asks for a wake now, and a lifespan task sends the due pushes.
Without a key every push route answers 404 ``push_unavailable`` and ``wake``
does nothing. The push routes take closed JSON bodies of at most 2,048 bytes,
declared before a byte is read.

The public shelf (#484, ``reconcile.relay.shelf``, listed-doors.md §4.2). With
the steward's public key set, ``PUT /v1/shelf/{address}`` stores one record
that ``address``'s key signed, and ``GET /v1/shelf`` pages every record that
isn't held, from every address, in seq order. These are the only bodies the
relay can read. Without the key both answer 404 ``shelf_unavailable``. A
record is at most 4,096 bytes, declared before a byte is read, and a PUT
that would take the shelf's unexpired records past ``max_shelf_bytes`` gets
507 ``shelf_full``, checked on the declared length and again just before the
insert. A record is kept 30 days. An address has one listing (#486): a later
copy takes the earlier one's row and seq and renews its 30 days, an open copy
after a final one gets 409 ``listing_final``, and a final copy deletes the
address's entries. An entry or a withdraw needs a live listing at its address
(409 ``not_listed``, #431); a repeat with the same address and id stores
nothing and returns the first copy's seq with 200; a withdraw names one of
the address's entries (409 ``no_entry``); and an address keeps at most 4 live
entries, a withdrawn one no longer live, and posts at most 1 new one each UTC
day (429 ``too_many_entries``).

Held mode (#488, listed-doors.md §4.2, the only mode built). An address's
first listing, and everything PUT under it while it waits, is stored held:
``GET /v1/shelf`` leaves it out, and ``GET /v1/shelf/held``, the steward's
console's read, pages held records alone in the same shape. A ``release``
notice clears an address's hold. A notice is PUT under the configured
steward key and signed by it; one under any other address gets 403
``bad_signature``. A notice is kept 180 days, a release at least as long as
the listing it released.

Nothing here logs. Error bodies are a constant ``{"error": "<code>"}`` that
never echoes the request. The privacy middleware wraps everything.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import re
import time
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, TypeVar

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect

from reconcile.relay import push, shelf
from reconcile.relay.privacy import PrivacyMiddleware
from reconcile.relay.settings import Settings, key_bytes
from reconcile.relay.store import (
    HELD_UNTIL_RELEASED,
    BlobStore,
    Record,
    ShelfRow,
    ShelfWhen,
    day_of,
    minute_of,
)

if TYPE_CHECKING:
    from fastapi.telemetry import TelemetryConfig
    from starlette.datastructures import Headers, QueryParams
    from starlette.types import ASGIApp

# Returns the current time in unix seconds, like time.time.
Clock = Callable[[], float]

MAILBOX_ID = re.compile(r"[A-Za-z0-9_-]{43}")
BLOB_SIZES = frozenset({1024, 4096, 16384, 65536})
# A backup's five sizes (#97): 64 KiB, 256 KiB, 1 MiB, 4 MiB and 16 MiB.
BACKUP_SIZES = frozenset({1 << 16, 1 << 18, 1 << 20, 1 << 22, 1 << 24})
# A backup is kept 180 whole days after the day of its last write (ADR-0057).
BACKUP_KEEP_DAYS = 180
# A shelf record is kept 30 whole days after the day it arrived (§4.2, proposed).
SHELF_KEEP_DAYS = 30
# A steward's notice is kept 180 whole days after the day it arrived (§4.2,
# proposed); a release, at least as long as the listing it released (#488).
NOTICE_KEEP_DAYS = 180
# An address's entries (#431, §4.2, proposed): at most 4 live, 1 new a relay day.
MAX_LIVE_ENTRIES = 4
MAX_NEW_ENTRIES_A_DAY = 1
OCTET_STREAM = "application/octet-stream"
JSON_MEDIA_TYPE = "application/json"
MAX_JSON_BYTES = 2048
MAX_SEQ = 2**63 - 1  # SQLite's largest INTEGER
MAX_DIGITS = len(str(MAX_SEQ))  # 19: longer input is refused before int()

# FastAPI's built-in OpenTelemetry would record each path (so each mailbox id)
# and its timing whenever a provider is configured. The relay keeps no logs.
NO_TELEMETRY: TelemetryConfig = {
    "tracing": False,
    "metrics": False,
    "logs": False,
    "operation_spans": False,
    "auto_configure": False,
}

_STATUS_CODES = {404: "not_found", 405: "method_not_allowed"}

# The type of the one field a push route's JSON body holds.
_Field = TypeVar("_Field", str, int)


@dataclass(frozen=True)
class IntParam:
    """A whole-number query parameter with a default and inclusive bounds."""

    name: str
    default: int
    low: int
    high: int
    code: str


TTL_DAYS = IntParam("ttl_days", default=30, low=1, high=30, code="invalid_ttl")
AFTER = IntParam("after", default=0, low=0, high=MAX_SEQ, code="invalid_after")
LIMIT = IntParam("limit", default=100, low=1, high=100, code="invalid_limit")


class RelayError(HTTPException):
    """A refusal whose body is the constant ``{"error": code}``."""

    def __init__(self, status_code: int, code: str) -> None:
        """Refuse with ``status_code`` and the error ``code``."""
        super().__init__(status_code=status_code, detail=code)
        self.code = code


def create_app(
    settings: Settings | None = None,
    clock: Clock | None = None,
    sender: push.PushSender | None = None,
) -> ASGIApp:
    """Build the relay.

    ``uvicorn --factory`` calls this with no arguments: ``None`` means settings
    from the environment, the system clock and, when a VAPID key is set, a
    real ``WebPushSender``. Tests inject all three.

    Raises:
        SettingsError: a setting is missing or malformed, including a VAPID
            key that won't load or a subject ``push.check_subject`` refuses.
    """
    settings = Settings.from_env() if settings is None else settings
    clock = time.time if clock is None else clock
    vapid = push.load_vapid(settings)
    store = BlobStore(settings.db_path)
    if vapid is not None and sender is None:
        sender = push.WebPushSender(vapid, clock)
    api = FastAPI(
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
        telemetry=NO_TELEMETRY,
        lifespan=_lifespan(store, None if vapid is None else sender, clock),
    )
    api.state.store = store
    _add_error_handlers(api)
    mailboxes = _Mailboxes(store, settings, clock, wakes=vapid is not None)
    api.add_api_route("/v1/mailbox/{mailbox}", mailboxes.put, methods=["PUT"])
    api.add_api_route("/v1/mailbox/{mailbox}", mailboxes.get, methods=["GET"])
    backups = _Backups(store, settings, clock)
    api.add_api_route("/v1/backup/{backup}", backups.put, methods=["PUT"])
    api.add_api_route("/v1/backup/{backup}", backups.get, methods=["GET"])
    pushes = _Push(store, settings, clock, vapid)
    api.add_api_route("/v1/push/key", pushes.key, methods=["GET"])
    api.add_api_route("/v1/push/{mailbox}", pushes.subscribe, methods=["PUT"])
    api.add_api_route("/v1/push/{mailbox}", pushes.unsubscribe, methods=["DELETE"])
    api.add_api_route("/v1/push/{mailbox}/nudge", pushes.nudge, methods=["POST"])
    shelves = _Shelf(store, settings, clock)
    api.add_api_route("/v1/shelf", shelves.get, methods=["GET"])
    api.add_api_route("/v1/shelf/held", shelves.get_held, methods=["GET"])
    api.add_api_route("/v1/shelf/{address}", shelves.put, methods=["PUT"])
    api.add_api_route("/v1/health", health, methods=["GET"])
    return PrivacyMiddleware(api)


async def health() -> dict[str, str]:
    """Say the relay is up."""
    return {"status": "ok"}


class _Mailboxes:
    """The mailbox routes, bound to one store, its settings and a clock."""

    def __init__(
        self, store: BlobStore, settings: Settings, clock: Clock, *, wakes: bool
    ) -> None:
        """Bind the routes; ``wakes`` is whether ``wake=1`` schedules a push."""
        self.store = store
        self.settings = settings
        self.clock = clock
        self.wakes = wakes

    async def put(self, mailbox: str, request: Request) -> JSONResponse:
        """Append one padded blob, kept ``ttl_days`` (default 30) rounded up.

        With ``wake=1`` and push on, the mailbox is due a wake in the minute
        the blob was received, once it is stored.
        """
        _check_mailbox(mailbox)
        ttl_days = _query_int(request.query_params, TTL_DAYS)
        wake = _wake(request.query_params)
        _check_media_type(request.headers, OCTET_STREAM)
        length = _blob_length(request.headers)
        _check_space(self.store, self.settings)
        self._check_room(mailbox, length, self.clock())
        blob = await _read_body(request, length)
        now = self.clock()  # only after the body: see the module docstring
        self._check_room(mailbox, length, now)  # another PUT may have landed
        seq = self.store.append(
            mailbox, blob, received=minute_of(now), expiry=day_of(now) + ttl_days + 1
        )
        if wake and self.wakes:
            self.store.add_wake(mailbox, minute_of(now), today=day_of(now))
        return JSONResponse({"seq": seq}, status_code=201)

    def _check_room(self, mailbox: str, length: int, now: float) -> None:
        """507 ``mailbox_full`` if ``length`` more bytes would pass the mailbox cap.

        Only blobs unexpired at ``now`` count, so a mailbox makes room as its
        blobs expire. The body is constant: it never names the mailbox.
        """
        used = self.store.mailbox_bytes(mailbox, today=day_of(now))
        if used + length > self.settings.max_mailbox_bytes:
            raise RelayError(507, "mailbox_full")

    async def get(self, mailbox: str, request: Request) -> JSONResponse:
        """Return unexpired records after a seq, ascending, with ``now``."""
        _check_mailbox(mailbox)
        after = _query_int(request.query_params, AFTER)
        limit = _query_int(request.query_params, LIMIT)
        now = self.clock()  # before the select: see the module docstring
        records = self.store.read(mailbox, after=after, limit=limit, today=day_of(now))
        return JSONResponse(
            {
                "records": [_record_json(record) for record in records],
                "now": minute_of(now),
                "instance": self.store.instance,
            }
        )


class _Backups:
    """The backup routes (#97), bound to one store, its settings and a clock."""

    def __init__(self, store: BlobStore, settings: Settings, clock: Clock) -> None:
        """Bind the routes."""
        self.store = store
        self.settings = settings
        self.clock = clock

    async def put(self, backup: str, request: Request) -> Response:
        """Keep one padded blob as ``backup``, replacing any earlier one.

        It expires on the UTC day of the write plus 181, so it is kept 180
        whole days after its last refresh, and the row holds no receipt time.
        """
        _check_id(backup, "invalid_backup")
        _check_media_type(request.headers, OCTET_STREAM)
        length = _bucket_length(request.headers, BACKUP_SIZES)
        _check_space(self.store, self.settings)
        blob = await _read_body(request, length)
        now = self.clock()
        self.store.put_backup(backup, blob, expiry=day_of(now) + BACKUP_KEEP_DAYS + 1)
        return Response(status_code=204)

    async def get(self, backup: str) -> Response:
        """Return the backup's bytes, or 404 ``not_found`` once it's gone."""
        _check_id(backup, "invalid_backup")
        blob = self.store.get_backup(backup, today=day_of(self.clock()))
        if blob is None:
            raise RelayError(404, "not_found")
        return Response(content=blob, media_type=OCTET_STREAM)


class _Push:
    """The push routes, bound to one store, its settings, a clock and the key."""

    def __init__(
        self,
        store: BlobStore,
        settings: Settings,
        clock: Clock,
        vapid: push.VapidKey | None,
    ) -> None:
        """Bind the routes; with no key (``None``) they are off."""
        self.store = store
        self.settings = settings
        self.clock = clock
        self.vapid = vapid

    def _on(self) -> push.VapidKey:
        """The key, or 404 ``push_unavailable`` before anything else is checked."""
        if self.vapid is None:
            raise RelayError(404, "push_unavailable")
        return self.vapid

    async def key(self) -> JSONResponse:
        """Serve the public key a device subscribes with."""
        return JSONResponse({"vapid_public_key": self._on().public_key})

    async def subscribe(self, mailbox: str, request: Request) -> Response:
        """Register an endpoint under ``mailbox`` for 30 days, or refresh it."""
        self._on()
        _check_mailbox(mailbox)
        endpoint = await _json_field(request, "endpoint", str, self._space)
        if push.endpoint_origin(endpoint) is None:
            raise RelayError(422, "push_endpoint_rejected")
        now = self.clock()
        self.store.subscribe(
            mailbox,
            endpoint,
            expiry=day_of(now) + push.SUB_TTL_DAYS + 1,
            keep=push.MAX_SUBS,
        )
        return Response(status_code=204)

    async def unsubscribe(self, mailbox: str, request: Request) -> Response:
        """Forget an endpoint under ``mailbox``: 204 whether or not it was there."""
        self._on()
        _check_mailbox(mailbox)
        endpoint = await _json_field(request, "endpoint", str, _no_check)
        self.store.unsubscribe(mailbox, endpoint)
        return Response(status_code=204)

    async def nudge(self, mailbox: str, request: Request) -> Response:
        """Schedule a wake of ``mailbox`` at relay minute ``not_before`` or later.

        A minute already past is stored as now. At most 30 days ahead, and
        at most 50 pending per mailbox.
        """
        self._on()
        _check_mailbox(mailbox)
        not_before = await _json_field(request, "not_before", int, self._space)
        now = minute_of(self.clock())
        if not 0 <= not_before <= now + push.NUDGE_HORIZON:
            raise RelayError(400, "invalid_not_before")
        if not self.store.add_nudge(
            mailbox, max(not_before, now), limit=push.MAX_NUDGES
        ):
            raise RelayError(429, "too_many_nudges")
        return Response(status_code=204)

    def _space(self) -> None:
        """Refuse a push write once the database and its WAL pass the cap."""
        _check_space(self.store, self.settings)


class _ShelfRead(Protocol):
    """A store's read of one page of shelf records: held ones, or the rest."""

    def __call__(
        self, *, after: int, limit: int, today: int, minute: int
    ) -> list[ShelfRow]:
        """Up to ``limit`` unexpired records after ``after``, at ``minute``."""
        ...


class _Shelf:
    """The shelf's routes (#484), bound to one store, its settings and a clock."""

    def __init__(self, store: BlobStore, settings: Settings, clock: Clock) -> None:
        """Bind the routes; with no steward key in ``settings`` they are off."""
        self.store = store
        self.settings = settings
        self.clock = clock

    def _on(self) -> None:
        """404 ``shelf_unavailable`` before anything else, while the key is unset."""
        if self.settings.shelf_steward_key is None:
            raise RelayError(404, "shelf_unavailable")

    async def put(self, address: str, request: Request) -> JSONResponse:
        """Store one record ``address`` signed, kept 30 days; 201 with its seq."""
        self._on()
        key = key_bytes(address)
        if key is None:
            raise RelayError(400, "invalid_address")
        _check_media_type(request.headers, OCTET_STREAM)
        length = _declared_length(request.headers, shelf.MAX_RECORD_BYTES)
        _check_space(self.store, self.settings)
        self._check_room(length, self.clock())
        body = await _read_body(request, length)
        record = shelf.open_record(key, body)
        if isinstance(record, shelf.Refusal):
            raise RelayError(record.status, record.code)
        if record.kind == "notice" and address != self.settings.shelf_steward_key:
            raise RelayError(403, "bad_signature")
        now = self.clock()  # only after the body, as for a blob
        self._check_room(length, now)  # another PUT may have landed
        seq, status = self._store(address, record, body, now)
        return JSONResponse({"seq": seq}, status_code=status)

    def _store(
        self, address: str, record: shelf.ShelfRecord, body: bytes, now: float
    ) -> tuple[int, int]:
        """File ``record`` by its kind; its seq, and 201, or 200 for a repeat.

        In held mode a first listing waits, and so does whatever comes under
        it before a release (#488).
        """
        received, today = minute_of(now), day_of(now)
        if record.kind == "notice":
            when = ShelfWhen(received=received, expiry=today + NOTICE_KEEP_DAYS + 1)
            seq = self.store.add_shelf(address, record.kind, record.ref, body, when)
            self.store.release(record.ref)
            return seq, 201
        expiry = today + SHELF_KEEP_DAYS + 1
        if record.kind == "listing":
            when = ShelfWhen(received, expiry, held_until=HELD_UNTIL_RELEASED)
            return self._list(address, record, body, when), 201
        first = self._first_of(address, record, today)
        if first is not None:
            return first, 200
        held = HELD_UNTIL_RELEASED if self.store.listing_held(address) else 0
        when = ShelfWhen(received, expiry, held_until=held)
        return self.store.add_shelf(address, record.kind, record.ref, body, when), 201

    def _first_of(
        self, address: str, record: shelf.ShelfRecord, today: int
    ) -> int | None:
        """The seq of an entry's or withdraw's first copy, or ``None`` for a new one.

        Either needs a live listing at ``address`` (409 ``not_listed``). A
        repeat stores nothing; a withdrawn entry repeats as the entry it was.
        A withdraw names an entry at ``address`` (409 ``no_entry``), and a new
        entry fits the caps (429 ``too_many_entries``).
        """
        listed = self.store.unexpired_listing(address, today=today)
        if listed is None or shelf.is_final(listed):
            raise RelayError(409, "not_listed")
        first = self.store.shelf_seq(address, record.kind, record.ref, today=today)
        if first is not None:
            return first
        if record.kind == "withdraw":
            if self.store.shelf_seq(address, "entry", record.ref, today=today) is None:
                raise RelayError(409, "no_entry")
            return None
        counts = self.store.entry_counts(address, today=today)
        if counts.live >= MAX_LIVE_ENTRIES or counts.today >= MAX_NEW_ENTRIES_A_DAY:
            raise RelayError(429, "too_many_entries")
        return None

    def _list(
        self, address: str, record: shelf.ShelfRecord, body: bytes, when: ShelfWhen
    ) -> int:
        """Store ``address``'s listing in place of its earlier one (#486).

        An open copy after a final one gets 409 ``listing_final``: the door
        has closed for good. A final copy deletes the address's entries.
        """
        standing = self.store.listing_body(address)
        if standing is not None and shelf.is_final(standing) and not record.final:
            raise RelayError(409, "listing_final")
        seq = self.store.put_listing(address, body, when)
        if record.final:
            self.store.drop_entries(address)
        return seq

    def _check_room(self, length: int, now: float) -> None:
        """507 ``shelf_full`` if ``length`` more bytes would pass the shelf's cap."""
        used = self.store.shelf_bytes(today=day_of(now))
        if used + length > self.settings.max_shelf_bytes:
            raise RelayError(507, "shelf_full")

    async def get(self, request: Request) -> JSONResponse:
        """Every record that isn't held, after a seq, ascending, with ``now``."""
        return self._page(request, self.store.read_shelf)

    async def get_held(self, request: Request) -> JSONResponse:
        """Every record still held, after a seq, ascending, with ``now`` (#488)."""
        return self._page(request, self.store.read_held)

    def _page(self, request: Request, read: _ShelfRead) -> JSONResponse:
        """One page of ``read``'s records, the relay's minute and its instance."""
        self._on()
        after = _query_int(request.query_params, AFTER)
        limit = _query_int(request.query_params, LIMIT)
        now = self.clock()  # before the select, as for a mailbox
        rows = read(after=after, limit=limit, today=day_of(now), minute=minute_of(now))
        return JSONResponse(
            {
                "records": [_shelf_json(row) for row in rows],
                "now": minute_of(now),
                "instance": self.store.instance,
            }
        )


def _shelf_json(row: ShelfRow) -> dict[str, Any]:
    """A shelf record as JSON: a blob's fields, and the address it was PUT under."""
    return {
        "seq": row.seq,
        "received": row.received,
        "address": row.address,
        "data": base64.b64encode(row.body).decode("ascii"),
    }


def _check_space(store: BlobStore, settings: Settings) -> None:
    """507 ``storage_full`` once the database and its WAL pass the cap."""
    if store.size_bytes() > settings.max_db_bytes:
        raise RelayError(507, "storage_full")


def _no_check() -> None:
    """A DELETE frees space, so it skips the storage check."""


def _wake(params: QueryParams) -> bool:
    """``wake=1`` asks for a wake; no ``wake`` asks for none; else 400."""
    raw = params.get("wake")
    if raw is None:
        return False
    if raw != "1":
        raise RelayError(400, "invalid_wake")
    return True


def _record_json(record: Record) -> dict[str, Any]:
    """A record as JSON, its blob in standard base64."""
    return {
        "seq": record.seq,
        "received": record.received,
        "data": base64.b64encode(record.blob).decode("ascii"),
    }


def _check_mailbox(mailbox: str) -> None:
    """Refuse a mailbox id that isn't 43 base64url characters."""
    _check_id(mailbox, "invalid_mailbox")


def _check_id(value: str, code: str) -> None:
    """Refuse anything but 43 base64url characters, with the error ``code``."""
    if MAILBOX_ID.fullmatch(value) is None:
        raise RelayError(400, code)


def _check_media_type(headers: Headers, expected: str) -> None:
    """Refuse a body that isn't declared as the ``expected`` media type."""
    media_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != expected:
        raise RelayError(415, "unsupported_media_type")


def _as_int(raw: str) -> int | None:
    """Parse at most 19 plain ASCII digits; anything else is ``None``."""
    if raw.isascii() and raw.isdigit() and len(raw) <= MAX_DIGITS:
        return int(raw)
    return None


def _query_int(params: QueryParams, param: IntParam) -> int:
    """Read ``param`` from the query string, or its default when absent."""
    raw = params.get(param.name)
    if raw is None:
        return param.default
    value = _as_int(raw)
    if value is None or not param.low <= value <= param.high:
        raise RelayError(400, param.code)
    return value


def _declared_length(headers: Headers, limit: int) -> int:
    """Check Content-Length, at most ``limit``, before reading a byte of the body."""
    raw = headers.get("content-length")
    if raw is None:
        raise RelayError(411, "length_required")
    if not (raw.isascii() and raw.isdigit()):
        raise RelayError(400, "invalid_length")
    length = _as_int(raw)
    if length is None or length > limit:
        raise RelayError(413, "too_large")
    return length


def _blob_length(headers: Headers) -> int:
    """A blob's declared length, which must be one of the four bucket sizes."""
    return _bucket_length(headers, BLOB_SIZES)


def _bucket_length(headers: Headers, sizes: frozenset[int]) -> int:
    """A declared length of at most ``max(sizes)``, which must be one of ``sizes``."""
    length = _declared_length(headers, max(sizes))
    if length not in sizes:
        raise RelayError(400, "invalid_size")
    return length


async def _json_field(
    request: Request, name: str, kind: type[_Field], check_space: Callable[[], None]
) -> _Field:
    """Read a body that is exactly ``{name: <kind>}``, checking it on the way.

    In order: JSON media type, Content-Length of at most 2,048 bytes, the
    storage cap (``check_space``), then the body, which must be UTF-8 JSON
    holding one object with that one key, its value of type ``kind`` (a
    bool is no int). Duplicate keys are refused, so no parser can read
    another value out of the same bytes.
    """
    _check_media_type(request.headers, JSON_MEDIA_TYPE)
    length = _declared_length(request.headers, MAX_JSON_BYTES)
    check_space()
    raw = await _read_body(request, length)
    try:
        body = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_keys)
    except (ValueError, RecursionError):
        raise RelayError(400, "invalid_request") from None
    if not isinstance(body, dict) or set(body) != {name}:
        raise RelayError(400, "invalid_request")
    value = body[name]
    if isinstance(value, bool) or not isinstance(value, kind):
        raise RelayError(400, "invalid_request")
    return value


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Build a JSON object, refusing one that names a key twice."""
    body = dict(pairs)
    if len(body) != len(pairs):
        raise ValueError
    return body


async def _read_body(request: Request, length: int) -> bytes:
    """Read exactly ``length`` bytes: no more, no fewer."""
    try:
        body = await _collect(request.stream(), limit=length)
    except ClientDisconnect:
        raise RelayError(400, "disconnected") from None
    if len(body) != length:
        raise RelayError(400, "invalid_size")
    return body


async def _collect(chunks: AsyncIterator[bytes], *, limit: int) -> bytes:
    """Join ``chunks``, stopping as soon as they run past ``limit`` bytes."""
    body = bytearray()
    async for chunk in chunks:
        body += chunk
        if len(body) > limit:
            raise RelayError(400, "invalid_size")
    return bytes(body)


def _lifespan(
    store: BlobStore, sender: push.PushSender | None, clock: Clock
) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    """A lifespan that runs the push tick, if any, then closes up at shutdown.

    The tick runs on the server's own event loop, between requests, like
    every other use of the store.
    """

    @asynccontextmanager
    async def lifespan(_api: FastAPI) -> AsyncIterator[None]:
        """Start the tick, run the app, then stop the tick and close up."""
        if sender is None:
            yield
            store.close()
            return
        ticking = asyncio.create_task(push.tick(store, sender, clock))
        yield
        ticking.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await ticking
        await sender.aclose()
        store.close()

    return lifespan


def _add_error_handlers(api: FastAPI) -> None:
    """Make every error body a constant ``{"error": code}``."""
    api.exception_handler(HTTPException)(_http_error)
    api.exception_handler(RequestValidationError)(_invalid_request)
    api.exception_handler(Exception)(_internal_error)


async def _http_error(_request: Request, exc: HTTPException) -> JSONResponse:
    """A refusal, or a routing 404 or 405."""
    code = (
        exc.code
        if isinstance(exc, RelayError)
        else _STATUS_CODES.get(exc.status_code, "error")
    )
    return JSONResponse(
        {"error": code}, status_code=exc.status_code, headers=exc.headers
    )


async def _invalid_request(
    _request: Request, _exc: RequestValidationError
) -> JSONResponse:
    """FastAPI's own validation errors, which would otherwise echo the input."""
    return JSONResponse({"error": "invalid_request"}, status_code=400)


async def _internal_error(_request: Request, _exc: Exception) -> JSONResponse:
    """Anything unexpected; the caller learns nothing about it."""
    return JSONResponse({"error": "internal"}, status_code=500)
