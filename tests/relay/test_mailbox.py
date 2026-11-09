"""The mailbox API: append opaque blobs, read them back in relay order."""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from typing import TYPE_CHECKING, Any

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from reconcile.relay.app import create_app
from reconcile.relay.privacy import PrivacyMiddleware
from reconcile.relay.purge import purge
from reconcile.relay.settings import Settings, SettingsError
from tests.relay.helpers import (
    DAY,
    MINUTE,
    OCTET_STREAM,
    FakeClock,
    api_of,
    blob,
    call,
    mailbox_id,
    put,
    row_count,
    store_of,
    stored_rows,
)

if TYPE_CHECKING:
    from pathlib import Path

    from starlette.types import ASGIApp

INSTANCE = re.compile(r"[A-Za-z0-9_-]{22}")


def _seqs(response: Any) -> list[int]:
    """The seqs of a GET response's records, in the order returned."""
    return [record["seq"] for record in response.json()["records"]]


def test_put_returns_201_with_the_new_seq(client: TestClient) -> None:
    """A valid PUT answers 201 with exactly {"seq": n}."""
    response = put(client, mailbox_id(), blob(), ttl_days=2)

    assert response.status_code == 201
    assert response.json() == {"seq": 1}


def test_get_after_the_first_seq_returns_the_second_and_third_in_order(
    client: TestClient,
) -> None:
    """Three PUTs, then GET after the first seq: exactly the other two, in order."""
    mailbox = mailbox_id()
    blobs = [blob(1024, 0x01), blob(4096, 0x02), blob(16384, 0x03)]
    seqs = [put(client, mailbox, data).json()["seq"] for data in blobs]

    response = client.get(f"/v1/mailbox/{mailbox}", params={"after": seqs[0]})

    assert response.status_code == 200
    records = response.json()["records"]
    assert [r["seq"] for r in records] == seqs[1:]
    assert [base64.b64decode(r["data"], validate=True) for r in records] == blobs[1:]


def test_get_defaults_after_to_zero(client: TestClient) -> None:
    """Without ``after``, GET starts from the beginning of the mailbox."""
    mailbox = mailbox_id()
    seqs = [put(client, mailbox, blob()).json()["seq"] for _ in range(3)]

    assert _seqs(client.get(f"/v1/mailbox/{mailbox}")) == seqs


def test_get_pages_with_limit(client: TestClient) -> None:
    """``limit`` caps a page, and ``after`` the last seq fetches the next page."""
    mailbox = mailbox_id()
    seqs = [put(client, mailbox, blob()).json()["seq"] for _ in range(3)]

    first = _seqs(client.get(f"/v1/mailbox/{mailbox}", params={"limit": 2}))
    rest = _seqs(
        client.get(f"/v1/mailbox/{mailbox}", params={"after": first[-1], "limit": 2})
    )

    assert first == seqs[:2]
    assert rest == seqs[2:]


def test_get_limit_defaults_to_one_hundred(client: TestClient) -> None:
    """A GET without ``limit`` returns at most 100 records."""
    mailbox = mailbox_id()
    for _ in range(101):
        put(client, mailbox, blob())

    assert len(_seqs(client.get(f"/v1/mailbox/{mailbox}"))) == 100


def test_data_is_standard_base64(client: TestClient) -> None:
    """``data`` uses the standard alphabet with padding, not base64url."""
    mailbox = mailbox_id()
    data = bytes([0xFB, 0xFF, 0xBF]) * 1365 + b"\xfb"  # 4,096 bytes, +/ heavy
    put(client, mailbox, data)

    (record,) = client.get(f"/v1/mailbox/{mailbox}").json()["records"]

    assert record["data"] == base64.b64encode(data).decode("ascii")
    assert "+" in record["data"]
    assert "/" in record["data"]


def test_unknown_mailbox_is_an_empty_list_not_a_404(client: TestClient) -> None:
    """A mailbox nobody wrote to looks exactly like an empty one."""
    response = client.get(f"/v1/mailbox/{mailbox_id()}")

    assert response.status_code == 200
    assert response.json()["records"] == []


def test_mailboxes_are_kept_apart(client: TestClient) -> None:
    """A GET returns only its own mailbox's records."""
    mine, theirs = mailbox_id(), mailbox_id()
    put(client, theirs, blob(fill=0x01))
    my_seq = put(client, mine, blob(fill=0x02)).json()["seq"]
    put(client, theirs, blob(fill=0x03))

    assert _seqs(client.get(f"/v1/mailbox/{mine}")) == [my_seq]


def test_seq_keeps_rising_after_a_purge_empties_the_table(
    client: TestClient, app: ASGIApp, clock: FakeClock
) -> None:
    """After a purge empties everything, the next seq is still a new, larger one."""
    mailbox = mailbox_id()
    seqs = [put(client, mailbox, blob(), ttl_days=1).json()["seq"] for _ in range(3)]
    clock.advance(2 * DAY)
    purge(store_of(app), clock())
    assert client.get(f"/v1/mailbox/{mailbox}").json()["records"] == []

    next_seq = put(client, mailbox, blob(), ttl_days=1).json()["seq"]

    assert next_seq > max(seqs)


def test_seq_is_not_reused_when_a_purge_drops_the_newest_rows(
    client: TestClient, app: ASGIApp, clock: FakeClock
) -> None:
    """A purge that drops the highest seqs mustn't let a later PUT reuse them."""
    kept, expiring = mailbox_id(), mailbox_id()
    put(client, kept, blob(), ttl_days=30)
    newest = [put(client, expiring, blob(), ttl_days=1).json()["seq"] for _ in range(2)]
    clock.advance(2 * DAY)
    purge(store_of(app), clock())

    next_seq = put(client, expiring, blob(), ttl_days=1).json()["seq"]

    assert next_seq > max(newest)


def test_get_carries_received_now_and_instance(
    client: TestClient, app: ASGIApp, clock: FakeClock
) -> None:
    """Records carry their receipt minute; the page carries ``now`` and ``instance``."""
    mailbox = mailbox_id()
    put(client, mailbox, blob())
    clock.advance(90)

    page = client.get(f"/v1/mailbox/{mailbox}").json()

    (record,) = page["records"]
    assert record["received"] == int(clock.now - 90) // MINUTE
    assert page["now"] == int(clock.now) // MINUTE
    assert page["instance"] == store_of(app).instance
    assert INSTANCE.fullmatch(page["instance"])
    assert set(page) == {"records", "now", "instance"}
    assert set(record) == {"seq", "received", "data"}


def test_get_reads_now_before_it_selects(
    db_path: Path, clock: FakeClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """GET reads the clock first, so anything it leaves out has received >= now."""
    calls: list[str] = []

    def spy_clock() -> float:
        """Note the clock read, then return the fake time."""
        calls.append("clock")
        return clock.now

    relay = create_app(Settings(db_path=db_path), spy_clock)
    store = store_of(relay)
    read = store.read

    def spy_read(*args: Any, **kwargs: Any) -> Any:
        """Note the select, then run it."""
        calls.append("select")
        return read(*args, **kwargs)

    monkeypatch.setattr(store, "read", spy_read)
    try:
        with TestClient(relay) as client:
            client.get(f"/v1/mailbox/{mailbox_id()}")
    finally:
        store.close()

    assert calls == ["clock", "select"]


def test_put_reads_the_clock_only_after_the_body_arrives(
    app: ASGIApp, clock: FakeClock, db_path: Path
) -> None:
    """A slow upload is stamped when it's stored, so no GET's ``now`` passes it.

    The PUT starts in one minute, a GET runs in the next minute while the body
    is still on its way, then the body lands. Had the PUT read the clock before
    its body, its record would carry an earlier minute than that GET's ``now``.
    """
    mailbox = mailbox_id()
    data = blob()
    start_minute = int(clock.now) // MINUTE

    async def scenario() -> dict[str, Any]:
        """Start a PUT, let a GET run a minute later, then finish the PUT."""
        waiting = asyncio.Event()
        release = asyncio.Event()

        async def slow_body() -> dict[str, Any]:
            """Hold the body back until the test releases it."""
            waiting.set()
            await release.wait()
            return {"type": "http.request", "body": data, "more_body": False}

        async def no_body() -> dict[str, Any]:
            """A GET has no body."""
            return {"type": "http.request", "body": b"", "more_body": False}

        headers = [
            (b"content-type", b"application/octet-stream"),
            (b"content-length", str(len(data)).encode()),
        ]
        path = f"/v1/mailbox/{mailbox}"
        upload = asyncio.ensure_future(
            call(app, "PUT", path, receive=slow_body, headers=headers)
        )
        await waiting.wait()
        clock.advance(MINUTE)
        page = await call(app, "GET", path, receive=no_body)
        release.set()
        assert (await upload).status == 201
        return dict(json.loads(page.body))

    page = asyncio.run(scenario())

    ((_, _, received, _),) = stored_rows(db_path)
    assert page["records"] == []
    assert page["now"] == start_minute + 1
    assert received >= page["now"]


def test_health(client: TestClient) -> None:
    """``GET /v1/health`` answers exactly {"status": "ok"}."""
    response = client.get("/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "path", ["/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"]
)
def test_docs_routes_are_off(client: TestClient, path: str) -> None:
    """No generated API docs or schema are served."""
    response = client.get(path)

    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


def test_unknown_route_has_a_constant_body(client: TestClient) -> None:
    """A 404 never echoes the path it was asked for."""
    response = client.get("/v1/nothing-here/203.0.113.7")

    assert response.status_code == 404
    assert response.content == b'{"error":"not_found"}'


def test_wrong_method_has_a_constant_body(client: TestClient) -> None:
    """A 405 says only that the method isn't allowed."""
    response = client.delete(f"/v1/mailbox/{mailbox_id()}")

    assert response.status_code == 405
    assert response.json() == {"error": "method_not_allowed"}


def test_trailing_slash_is_not_redirected(client: TestClient) -> None:
    """No redirect echoes a path back in a Location header."""
    response = client.get("/v1/health/", follow_redirects=False)

    assert response.status_code == 404
    assert "location" not in response.headers


def test_storage_full_refuses_the_put_and_stores_nothing(
    client: TestClient, app: ASGIApp, db_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Over the size cap a PUT gets 507; at exactly the cap it still fits."""
    store = store_of(app)
    cap = Settings(db_path=db_path).max_db_bytes
    monkeypatch.setattr(store, "size_bytes", lambda: cap + 1)

    full = put(client, mailbox_id(), blob())

    assert full.status_code == 507
    assert full.json() == {"error": "storage_full"}
    assert row_count(db_path) == 0

    monkeypatch.setattr(store, "size_bytes", lambda: cap)
    assert put(client, mailbox_id(), blob()).status_code == 201


def test_storage_cap_comes_from_settings(db_path: Path, clock: FakeClock) -> None:
    """A real database already over a tiny cap refuses PUTs."""
    relay = create_app(Settings(db_path=db_path, max_db_bytes=1), clock)
    try:
        with TestClient(relay) as client:
            response = put(client, mailbox_id(), blob())
    finally:
        store_of(relay).close()

    assert response.status_code == 507
    assert row_count(db_path) == 0


def test_create_app_reads_the_environment_and_the_system_clock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``uvicorn --factory`` calls ``create_app()`` with no arguments."""
    db_path = tmp_path / "from-env.db"
    monkeypatch.setenv("RECONCILE_RELAY_DB", str(db_path))
    relay = create_app()
    try:
        with TestClient(relay) as client:
            mailbox = mailbox_id()
            put(client, mailbox, blob())
            before = int(time.time()) // MINUTE
            page = client.get(f"/v1/mailbox/{mailbox}").json()
            after = int(time.time()) // MINUTE
    finally:
        store_of(relay).close()

    assert isinstance(relay, PrivacyMiddleware)
    assert before <= page["now"] <= after
    assert row_count(db_path) == 1


def test_create_app_without_a_database_setting_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """There is no default database path outside ``scripts/relay.sh``."""
    monkeypatch.delenv("RECONCILE_RELAY_DB", raising=False)

    with pytest.raises(SettingsError):
        create_app()


class _RevealingError(RuntimeError):
    """An error whose message carries an address and a secret."""

    def __init__(self) -> None:
        """Carry the revealing message."""
        super().__init__("203.0.113.7 secret detail")


def test_unexpected_errors_get_a_constant_500(app: ASGIApp) -> None:
    """An unhandled exception's message never reaches the caller."""
    api = api_of(app)

    async def explode() -> None:
        """A test-only route that fails with a revealing message."""
        raise _RevealingError

    api.add_api_route("/test-only/explode", explode)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/test-only/explode")

    assert response.status_code == 500
    assert response.content == b'{"error":"internal"}'


def test_validation_errors_get_a_constant_400(app: ASGIApp) -> None:
    """FastAPI's own validation errors don't echo the bad input."""
    api = api_of(app)

    async def typed(number: int) -> dict[str, int]:
        """A test-only route with a typed query parameter."""
        return {"number": number}

    api.add_api_route("/test-only/typed", typed)
    with TestClient(app) as client:
        response = client.get("/test-only/typed", params={"number": "203.0.113.7"})

    assert response.status_code == 400
    assert response.content == b'{"error":"invalid_request"}'


def test_put_and_get_are_the_only_mailbox_methods(client: TestClient) -> None:
    """POST to a mailbox is refused like any other unknown method."""
    response = client.post(
        f"/v1/mailbox/{mailbox_id()}", content=blob(), headers=OCTET_STREAM
    )

    assert response.status_code == 405


def test_api_is_a_fastapi_app_inside_the_privacy_middleware(app: ASGIApp) -> None:
    """``create_app`` returns the privacy middleware as the outermost layer."""
    assert isinstance(app, PrivacyMiddleware)
    assert isinstance(app.app, FastAPI)
