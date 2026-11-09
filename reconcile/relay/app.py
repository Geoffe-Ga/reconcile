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

Nothing here logs. Error bodies are a constant ``{"error": "<code>"}`` that
never echoes the request. The privacy middleware wraps everything.
"""

from __future__ import annotations

import base64
import re
import time
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect

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


def create_app(settings: Settings | None = None, clock: Clock | None = None) -> ASGIApp:
    """Build the relay.

    ``uvicorn --factory`` calls this with no arguments: ``None`` means settings
    from the environment and the system clock. Tests inject both.
    """
    settings = Settings.from_env() if settings is None else settings
    store = BlobStore(settings.db_path)
    api = FastAPI(
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
        telemetry=NO_TELEMETRY,
        lifespan=_closing(store),
    )
    api.state.store = store
    _add_error_handlers(api)
    mailboxes = _Mailboxes(store, settings, time.time if clock is None else clock)
    api.add_api_route("/v1/mailbox/{mailbox}", mailboxes.put, methods=["PUT"])
    api.add_api_route("/v1/mailbox/{mailbox}", mailboxes.get, methods=["GET"])
    api.add_api_route("/v1/health", health, methods=["GET"])
    return PrivacyMiddleware(api)


async def health() -> dict[str, str]:
    """Say the relay is up."""
    return {"status": "ok"}


class _Mailboxes:
    """The mailbox routes, bound to one store, its settings and a clock."""

    def __init__(self, store: BlobStore, settings: Settings, clock: Clock) -> None:
        """Bind the routes to ``store``, ``settings`` and ``clock``."""
        self.store = store
        self.settings = settings
        self.clock = clock

    async def put(self, mailbox: str, request: Request) -> JSONResponse:
        """Append one padded blob, kept ``ttl_days`` (default 30) rounded up."""
        _check_mailbox(mailbox)
        ttl_days = _query_int(request.query_params, TTL_DAYS)
        _check_media_type(request.headers)
        length = _declared_length(request.headers)
        if self.store.size_bytes() > self.settings.max_db_bytes:
            raise RelayError(507, "storage_full")
        blob = await _read_body(request, length)
        now = self.clock()  # only after the body: see the module docstring
        seq = self.store.append(
            mailbox, blob, received=minute_of(now), expiry=day_of(now) + ttl_days + 1
        )
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


def _check_media_type(headers: Headers) -> None:
    """Refuse a body that isn't declared as ``application/octet-stream``."""
    media_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != OCTET_STREAM:
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


def _declared_length(headers: Headers) -> int:
    """Check Content-Length before reading a byte of the body."""
    raw = headers.get("content-length")
    if raw is None:
        raise RelayError(411, "length_required")
    if not (raw.isascii() and raw.isdigit()):
        raise RelayError(400, "invalid_length")
    length = _as_int(raw)
    if length is None or length > MAX_BLOB_BYTES:
        raise RelayError(413, "too_large")
    if length not in BLOB_SIZES:
        raise RelayError(400, "invalid_size")
    return length


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


def _closing(
    store: BlobStore,
) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    """A lifespan that closes ``store`` when the server shuts down."""

    @asynccontextmanager
    async def lifespan(_api: FastAPI) -> AsyncIterator[None]:
        """Run the app, then close the store."""
        yield
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
