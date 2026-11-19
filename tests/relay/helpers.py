"""Helpers shared by the relay tests: ids, blobs, requests and raw ASGI calls."""

from __future__ import annotations

import base64
import datetime as dt
import json
import secrets
import sqlite3
from collections.abc import Awaitable, Callable, Mapping
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from fastapi import FastAPI

from reconcile.relay.privacy import PrivacyMiddleware
from reconcile.relay.push import run_due
from reconcile.relay.store import BlobStore

if TYPE_CHECKING:
    from starlette.testclient import TestClient

OCTET_STREAM = {"content-type": "application/octet-stream"}
BLOB_SIZES = (1024, 4096, 16384, 65536)
# A backup's five sizes (#97): 64 KiB, 256 KiB, 1 MiB, 4 MiB and 16 MiB.
BACKUP_SIZES = (65536, 262144, 1048576, 4194304, 16777216)
MAX_BACKUP = BACKUP_SIZES[-1]

# 2026-11-09T12:00:00Z, the middle of UTC day 20,766.
NOON = dt.datetime(2026, 11, 9, 12, tzinfo=dt.UTC).timestamp()
DAY = 86_400
MINUTE = 60

Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]

# What deploy.sh sets: https:// and the site's domain (RFC 2606's example.org).
SUBJECT = "https://relay.example.org"


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


def put_backup(
    client: TestClient,
    backup: str,
    data: bytes,
    *,
    headers: Mapping[str, str] | None = None,
) -> Any:
    """PUT ``data`` to the backup ``backup`` as an octet stream (#97)."""
    return client.put(
        f"/v1/backup/{backup}",
        content=data,
        headers={**OCTET_STREAM, **(headers or {})},
    )


def backup_rows(db_path: Path) -> list[tuple[Any, ...]]:
    """Every ``backups`` row as (id, blob length, expiry), by id."""
    with closing(sqlite3.connect(db_path)) as db:
        query = "SELECT id, length(blob), expiry FROM backups ORDER BY id"
        return list(db.execute(query).fetchall())


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


# --- Web Push --------------------------------------------------------------


def write_vapid_key(path: Path) -> ec.EllipticCurvePrivateKey:
    """Write a fresh P-256 key to ``path`` as ``openssl ecparam -noout`` would.

    Keys are made at run time, so none is ever committed.
    """
    key = ec.generate_private_key(ec.SECP256R1())
    path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    return key


def push_endpoint(host: str = "web.push.apple.com", path: str | None = None) -> str:
    """An endpoint on ``host``, with a random path unless one is given."""
    return f"https://{host}/{secrets.token_urlsafe(24) if path is None else path}"


class UnreachableError(ConnectionError):
    """A transport failure whose message names the endpoint, as real ones do."""

    def __init__(self, endpoint: str) -> None:
        """Name ``endpoint``."""
        super().__init__(f"couldn't reach {endpoint}")


@dataclass
class FakeSender:
    """A push sender that records each endpoint and answers from a table.

    Endpoints default to 201. One in ``failing`` raises with the endpoint in
    the message, as a transport error would.
    """

    statuses: dict[str, int] = field(default_factory=dict)
    failing: set[str] = field(default_factory=set)
    sent: list[str] = field(default_factory=list)
    closed: bool = False

    async def send(self, endpoint: str) -> int:
        """Record ``endpoint``, then answer or raise."""
        self.sent.append(endpoint)
        if endpoint in self.failing:
            raise UnreachableError(endpoint)
        return self.statuses.get(endpoint, 201)

    async def aclose(self) -> None:
        """Note that the relay closed its sender."""
        self.closed = True


def subscribe(client: TestClient, mailbox: str, endpoint: Any) -> Any:
    """PUT ``{"endpoint": endpoint}`` to ``mailbox``'s push route."""
    return client.put(f"/v1/push/{mailbox}", json={"endpoint": endpoint})


def unsubscribe(client: TestClient, mailbox: str, endpoint: Any) -> Any:
    """DELETE ``{"endpoint": endpoint}`` from ``mailbox``'s push route."""
    return client.request("DELETE", f"/v1/push/{mailbox}", json={"endpoint": endpoint})


def nudge(client: TestClient, mailbox: str, not_before: Any) -> Any:
    """POST ``{"not_before": not_before}`` to ``mailbox``'s nudge route."""
    return client.post(f"/v1/push/{mailbox}/nudge", json={"not_before": not_before})


def wake_put(client: TestClient, mailbox: str, wake: str = "1") -> Any:
    """PUT a 1 KiB blob to ``mailbox`` with ``wake`` in the query."""
    return client.put(
        f"/v1/mailbox/{mailbox}",
        params={"wake": wake},
        content=blob(),
        headers=OCTET_STREAM,
    )


def tick(client: TestClient, app: object, sender: FakeSender, now: float) -> None:
    """Run one ``run_due`` at ``now`` on the app's own event loop."""
    assert client.portal is not None, "use the client inside its with block"
    client.portal.call(run_due, store_of(app), sender, now)


def push_rows(db_path: Path) -> list[tuple[Any, ...]]:
    """Every ``push_subs`` row as (mailbox, endpoint, expiry), sorted."""
    with closing(sqlite3.connect(db_path)) as db:
        query = "SELECT mailbox, endpoint, expiry FROM push_subs ORDER BY 1, 2"
        return list(db.execute(query).fetchall())


def nudge_rows(db_path: Path) -> list[tuple[Any, ...]]:
    """Every ``nudges`` row as (mailbox, due), sorted."""
    with closing(sqlite3.connect(db_path)) as db:
        return list(db.execute("SELECT mailbox, due FROM nudges ORDER BY 1, 2"))


# --- The public shelf (#484) -----------------------------------------------

SHELF_TAG = b"reconcile/v1/shelf\x00"


@dataclass(frozen=True)
class ShelfSigner:
    """An Ed25519 key that signs shelf records, as a door's ``sign`` key does."""

    key: ed25519.Ed25519PrivateKey

    @classmethod
    def fresh(cls) -> ShelfSigner:
        """A new key, made at run time so none is ever committed."""
        return cls(ed25519.Ed25519PrivateKey.generate())

    @property
    def address(self) -> str:
        """The public key in unpadded base64url: the address it posts under."""
        raw = self.key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    def sign(self, message: bytes) -> bytes:
        """A record: the signature over the shelf tag, 0x00 and ``message``, then it."""
        return self.key.sign(SHELF_TAG + message) + message

    def record(self, body: Mapping[str, Any]) -> bytes:
        """``body`` as compact UTF-8 JSON, signed."""
        return self.sign(compact(body))


# A notice's nonce: 16 random bytes in canonical unpadded base64url (§4.1).
NONCE_BYTES = 16
MINUTES_PER_DAY = DAY // MINUTE


def nonce() -> str:
    """A fresh notice nonce, made at run time: 22 base64url characters."""
    raw = secrets.token_bytes(NONCE_BYTES)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def notice(act: str, **fields: Any) -> dict[str, Any]:
    """A notice's body before its stamp: ``act`` and whatever it names."""
    return {"v": 1, "kind": "notice", "act": act, **fields}


def stamped(
    body: Mapping[str, Any], *, day: int, n: str | None = None
) -> dict[str, Any]:
    """``body`` with the day the steward signed it and a nonce, fresh unless given."""
    return {**body, "day": day, "n": nonce() if n is None else n}


def relay_day(client: TestClient) -> int:
    """The relay's UTC day, from the ``now`` a shelf GET returns; else ``NOON``'s."""
    response = client.get("/v1/shelf", params={"limit": "1"})
    if response.status_code != 200:
        return int(NOON // DAY)
    return int(response.json()["now"]) // MINUTES_PER_DAY


def put_notice(
    client: TestClient,
    steward: ShelfSigner,
    body: Mapping[str, Any],
    *,
    day: int | None = None,
    n: str | None = None,
) -> Any:
    """PUT ``body`` as the steward's notice, stamped with the relay's day."""
    when = relay_day(client) if day is None else day
    return put_shelf(
        client, steward.address, steward.record(stamped(body, day=when, n=n))
    )


def compact(body: Mapping[str, Any]) -> bytes:
    """``body`` as compact UTF-8 JSON, as a device writes a shelf record."""
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()


def listing(name: str = "Oak St Tenants") -> dict[str, Any]:
    """An open listing's body; the relay reads only its kind."""
    return {
        "v": 1,
        "kind": "listing",
        "open": True,
        "name": name,
        "skeleton": name.lower().replace(" ", ""),
        "covenant": "A" * 43,
    }


def final_listing() -> dict[str, Any]:
    """A final listing's body: the door has closed for good (#486)."""
    return {"v": 1, "kind": "listing", "open": False, "final": True}


def entry(entry_id: str = "d" * 43, text: str = "Saturday at ten.") -> dict[str, Any]:
    """An entry's body under the id ``entry_id``."""
    return {
        "v": 1,
        "kind": "entry",
        "id": entry_id,
        "title": "Rent strike vote",
        "text": text,
    }


def put_shelf(
    client: TestClient,
    address: str,
    data: bytes,
    *,
    headers: Mapping[str, str] | None = None,
) -> Any:
    """PUT the record ``data`` under ``address`` as an octet stream."""
    return client.put(
        f"/v1/shelf/{address}",
        content=data,
        headers={**OCTET_STREAM, **(headers or {})},
    )


def shelf_rows(db_path: Path) -> list[tuple[Any, ...]]:
    """Every ``shelf`` row but its body, by seq."""
    with closing(sqlite3.connect(db_path)) as db:
        query = (
            "SELECT seq, address, kind, ref, length(body), received, expiry, held_until"
            " FROM shelf ORDER BY seq"
        )
        return list(db.execute(query).fetchall())
