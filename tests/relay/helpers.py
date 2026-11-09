"""Helpers shared by the relay tests: ids, blobs, requests and raw ASGI calls."""

from __future__ import annotations

import datetime as dt
import secrets
import sqlite3
from collections.abc import Awaitable, Callable, Mapping
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from reconcile.relay.privacy import PrivacyMiddleware
from reconcile.relay.store import BlobStore

if TYPE_CHECKING:
    from starlette.testclient import TestClient

OCTET_STREAM = {"content-type": "application/octet-stream"}
BLOB_SIZES = (1024, 4096, 16384, 65536)

# 2026-11-09T12:00:00Z, the middle of UTC day 20,766.
NOON = dt.datetime(2026, 11, 9, 12, tzinfo=dt.UTC).timestamp()
DAY = 86_400
MINUTE = 60

Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]


@dataclass
class FakeClock:
    """A settable clock in unix seconds, injected in place of ``time.time``."""

    now: float = NOON

    def __call__(self) -> float:
        """Return the current fake time."""
        return self.now

    def advance(self, seconds: float) -> None:
        """Move the clock forward by ``seconds``."""
        self.now += seconds


def mailbox_id() -> str:
    """Return a fresh, valid mailbox id: 32 random bytes in base64url (43 chars)."""
    return secrets.token_urlsafe(32)


def blob(size: int = 1024, fill: int = 0x41) -> bytes:
    """Return a padded blob of ``size`` bytes filled with ``fill``."""
    return bytes([fill]) * size


def api_of(app: object) -> FastAPI:
    """Return the FastAPI app inside ``create_app``'s privacy middleware."""
    assert isinstance(app, PrivacyMiddleware)
    api = app.app
    assert isinstance(api, FastAPI)
    return api


def store_of(app: object) -> BlobStore:
    """Return the store a relay app writes to."""
    store = api_of(app).state.store
    assert isinstance(store, BlobStore)
    return store


def put(
    client: TestClient,
    mailbox: str,
    data: bytes,
    *,
    ttl_days: int | str | None = None,
    headers: Mapping[str, str] | None = None,
) -> Any:
    """PUT ``data`` to ``mailbox`` as an octet stream and return the response."""
    params = {} if ttl_days is None else {"ttl_days": str(ttl_days)}
    return client.put(
        f"/v1/mailbox/{mailbox}",
        params=params,
        content=data,
        headers={**OCTET_STREAM, **(headers or {})},
    )


def row_count(db_path: Path) -> int:
    """Count the rows in ``blobs`` through a separate connection."""
    with closing(sqlite3.connect(db_path)) as db:
        (count,) = db.execute("SELECT count(*) FROM blobs").fetchone()
    return int(count)


def stored_rows(db_path: Path) -> list[tuple[Any, ...]]:
    """Return every ``blobs`` row as (mailbox, seq, received, expiry), by seq."""
    with closing(sqlite3.connect(db_path)) as db:
        query = "SELECT mailbox, seq, received, expiry FROM blobs ORDER BY seq"
        return list(db.execute(query).fetchall())


def sqlite_files(db_path: Path) -> dict[str, bytes]:
    """Return the raw bytes of the database, its WAL and its shared memory."""
    found = {}
    for suffix in ("", "-wal", "-shm"):
        path = Path(f"{db_path}{suffix}")
        if path.exists():
            found[path.name] = path.read_bytes()
    return found


@dataclass
class AsgiResult:
    """What a raw ASGI call sent back."""

    status: int
    body: bytes
    headers: list[tuple[bytes, bytes]] = field(default_factory=list)


async def call(
    app: Callable[..., Awaitable[None]],
    method: str,
    path: str,
    *,
    receive: Receive,
    headers: list[tuple[bytes, bytes]] | None = None,
    query: bytes = b"",
) -> AsgiResult:
    """Call ``app`` with a hand-built HTTP scope, as a server would."""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query,
        "root_path": "",
        "headers": headers or [],
        "client": ("192.0.2.1", 50000),
        "server": ("127.0.0.1", 8787),
    }
    sent: list[Message] = []

    async def send(message: Message) -> None:
        sent.append(message)

    await app(scope, receive, send)
    start = sent[0]
    body = b"".join(m.get("body", b"") for m in sent[1:])
    return AsgiResult(start["status"], body, list(start.get("headers", [])))


def body_receiver(*chunks: bytes) -> tuple[Receive, list[Message]]:
    """Return a ``receive`` that yields ``chunks``, and a log of what it gave."""
    given: list[Message] = []
    queue = list(chunks)

    async def receive() -> Message:
        message: Message
        if queue:
            chunk = queue.pop(0)
            message = {"type": "http.request", "body": chunk, "more_body": bool(queue)}
        else:
            message = {"type": "http.disconnect"}
        given.append(message)
        return message

    return receive, given
