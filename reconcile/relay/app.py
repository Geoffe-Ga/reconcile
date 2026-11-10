"""The relay's HTTP API: a blind mailbox (ADR-0019, ADR-0028, ADR-0073).

Clients append opaque, padded blobs to a mailbox and read them back in order.
The unguessable 43-character mailbox id is the only capability: there are no
accounts and no tokens.

Ordering and time. Run one Uvicorn worker: the handlers are ``async`` and call
SQLite synchronously, so no two of them touch the store at once. Two rules
keep the receipt minutes honest, which #63's deadline rule relies on:

- A GET reads the clock before it selects, so every record it leaves out
  has ``received`` >= the ``now`` it returns.
- A PUT reads the clock only after its whole body has arrived, with no
  ``await`` between that and the insert, so a slow upload can't be stamped
  earlier than a GET that ran while it was still arriving.

Push (#89, ``reconcile.relay.push``). With a VAPID key set, devices register
push endpoints and schedule nudges under ``/v1/push/``, a blob PUT with
``wake=1`` asks for a wake now, and a lifespan task sends the due pushes.
Without a key every push route answers 404 ``push_unavailable`` and ``wake``
does nothing. The push routes take closed JSON bodies of at most 2,048 bytes,
declared before a byte is read.

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
from typing import TYPE_CHECKING, Any, TypeVar

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect

from reconcile.relay import push
from reconcile.relay.privacy import PrivacyMiddleware
from reconcile.relay.settings import Settings
from reconcile.relay.store import BlobStore, Record, day_of, minute_of

if TYPE_CHECKING:
    from fastapi.telemetry import TelemetryConfig
    from starlette.datastructures import Headers, QueryParams
    from starlette.types import ASGIApp

# Returns the current time in unix seconds, like time.time.
Clock = Callable[[], float]

MAILBOX_ID = re.compile(r"[A-Za-z0-9_-]{43}")
BLOB_SIZES = frozenset({1024, 4096, 16384, 65536})
MAX_BLOB_BYTES = max(BLOB_SIZES)
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
    pushes = _Push(store, settings, clock, vapid)
    api.add_api_route("/v1/push/key", pushes.key, methods=["GET"])
    api.add_api_route("/v1/push/{mailbox}", pushes.subscribe, methods=["PUT"])
    api.add_api_route("/v1/push/{mailbox}", pushes.unsubscribe, methods=["DELETE"])
    api.add_api_route("/v1/push/{mailbox}/nudge", pushes.nudge, methods=["POST"])
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
        blob = await _read_body(request, length)
        now = self.clock()  # only after the body: see the module docstring
        seq = self.store.append(
            mailbox, blob, received=minute_of(now), expiry=day_of(now) + ttl_days + 1
        )
        if wake and self.wakes:
            self.store.add_wake(mailbox, minute_of(now), today=day_of(now))
        return JSONResponse({"seq": seq}, status_code=201)

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
    """Refuse anything but 43 base64url characters."""
    if MAILBOX_ID.fullmatch(mailbox) is None:
        raise RelayError(400, "invalid_mailbox")


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
    length = _declared_length(headers, MAX_BLOB_BYTES)
    if length not in BLOB_SIZES:
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
