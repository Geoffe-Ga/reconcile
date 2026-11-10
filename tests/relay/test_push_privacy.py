"""Push leaves no endpoint, key or address where the issue doesn't put one (#89).

An endpoint is a capability URL tied to one phone: whoever holds it can wake
that phone, and with the provider's help find out whose it is. The relay
keeps it in ``push_subs`` for at most 30 days and nowhere else: not in its
output or logs, whatever a push service answers, and not in the SQLite files
once the row is gone and the purge has run.

Each endpoint carries a random canary path, so a match can only come from
these tests.
"""

from __future__ import annotations

import logging
import secrets
import time
from typing import TYPE_CHECKING, Any

import httpx2
import pytest
from starlette.testclient import TestClient

from reconcile.relay import push
from reconcile.relay.app import create_app
from reconcile.relay.purge import purge
from reconcile.relay.push import WebPushSender, load_vapid
from tests.relay.helpers import (
    DAY,
    FakeClock,
    mailbox_id,
    push_rows,
    sqlite_files,
    store_of,
    subscribe,
    unsubscribe,
    wake_put,
)
from tests.relay.test_privacy import CANARY, CANARY_HEADERS, CLIENT_ADDRESSES

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from pathlib import Path

    from reconcile.relay.settings import Settings


def _canary_endpoint(host: str = "web.push.apple.com") -> tuple[str, str]:
    """An endpoint whose path is a fresh canary, and that canary."""
    canary = f"pushcanary{secrets.token_hex(8)}"
    return f"https://{host}/{canary}", canary


def _parts(endpoint: str) -> list[str]:
    """The pieces of an endpoint that must not show up: whole, path and host."""
    host, _, path = endpoint.removeprefix("https://").partition("/")
    return [endpoint, path, host]


def _found(haystack: bytes, needles: list[str]) -> list[str]:
    """The needles that occur in ``haystack``."""
    return [needle for needle in needles if needle.encode() in haystack]


class _Service:
    """A push service that answers each endpoint its own way, raising for some."""

    def __init__(self, answers: dict[str, Any]) -> None:
        """``answers`` maps an endpoint to a status, or to an exception to raise."""
        self.answers = answers
        self.asked: list[str] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        """Answer, or raise an error that names the endpoint, as transports do."""
        url = str(request.url)
        self.asked.append(url)
        answer = self.answers[url]
        if isinstance(answer, type) and issubclass(answer, Exception):
            message = _naming(url)
            if issubclass(answer, httpx2.RequestError):
                raise answer(message, request=request)
            raise answer(message)
        return httpx2.Response(answer, headers={"location": url})


def _naming(url: str) -> str:
    """An error message that names the endpoint, as transport errors do."""
    return f"couldn't connect to {url}"


@pytest.fixture
def logged(
    caplog: pytest.LogCaptureFixture, capfd: pytest.CaptureFixture[str]
) -> Iterator[Any]:
    """Every log record at any level, plus stdout and stderr, read on demand."""
    caplog.set_level(logging.DEBUG)

    def read() -> bytes:
        """What has been printed or logged so far, as bytes."""
        out, err = capfd.readouterr()
        records = "\n".join(
            f"{record.name} {record.getMessage()} {record.exc_text or ''}"
            for record in caplog.records
        )
        return (out + err + records).encode()

    yield read


def _push_relay(
    push_settings: Settings, clock: FakeClock, service: _Service
) -> tuple[Any, WebPushSender]:
    """A push-on relay whose real sender talks to ``service``."""
    vapid = load_vapid(push_settings)
    assert vapid is not None
    sender = WebPushSender(vapid, clock, transport=httpx2.MockTransport(service))
    return create_app(push_settings, clock, sender=sender), sender


def _wait_for(condition: Any) -> None:
    """Poll until ``condition`` holds, for up to ten seconds."""
    deadline = time.monotonic() + 10
    while not condition():
        assert time.monotonic() < deadline, "the tick never ran"
        time.sleep(0.01)


def test_sends_of_every_outcome_leave_no_endpoint_in_output_or_logs(
    push_settings: Settings,
    clock: FakeClock,
    monkeypatch: pytest.MonkeyPatch,
    logged: Any,
) -> None:
    """Successful, refused, redirected and raising sends all stay silent.

    httpx2 logs each request's URL at INFO, so leaving its logger on fails
    this, and so does logging a swallowed exception.
    """
    outcomes: list[Any] = [
        201,
        202,
        404,
        410,
        500,
        301,
        httpx2.ConnectError,
        httpx2.ReadTimeout,
        RuntimeError,
    ]
    endpoints = [_canary_endpoint()[0] for _ in outcomes]
    service = _Service(dict(zip(endpoints, outcomes, strict=True)))
    monkeypatch.setattr(push, "TICK_SECONDS", 0.01)
    relay, _ = _push_relay(push_settings, clock, service)
    mailbox = mailbox_id()
    try:
        with TestClient(relay) as client:
            for endpoint in endpoints:
                assert subscribe(client, mailbox, endpoint).status_code == 204
            wake_put(client, mailbox)
            _wait_for(lambda: len(service.asked) == len(endpoints))
    finally:
        store_of(relay).close()

    needles = [part for endpoint in endpoints for part in _parts(endpoint)]
    assert sorted(service.asked) == sorted(endpoints)
    assert _found(logged(), needles) == []


def test_a_refused_endpoint_or_auth_secret_never_reaches_the_files(
    push_client: TestClient, db_path: Path, logged: Any
) -> None:
    """What the relay refuses it doesn't write: not the endpoint, not ``keys``."""
    refused, refused_canary = _canary_endpoint("evil.example")
    secret = f"authcanary{secrets.token_hex(8)}"
    keyed, keyed_canary = _canary_endpoint()

    off_list = subscribe(push_client, mailbox_id(), refused)
    with_keys = push_client.put(
        f"/v1/push/{mailbox_id()}",
        json={"endpoint": keyed, "keys": {"p256dh": secret, "auth": secret}},
    )

    assert off_list.status_code == 422
    assert with_keys.status_code == 400
    needles = [refused_canary, keyed_canary, secret]
    for name, data in sqlite_files(db_path).items():
        assert _found(data, needles) == [], name
    assert _found(logged(), needles) == []
    assert _found(off_list.content + with_keys.content, needles) == []


def _no_trace(db_path: Path, endpoint: str) -> None:
    """The endpoint's path is in none of the SQLite files."""
    _, canary = endpoint.rsplit("/", 1)
    files = sqlite_files(db_path)
    assert {"relay.db", "relay.db-wal"} <= set(files)
    for name, data in files.items():
        assert canary.encode() not in data, name


def _stored(
    checkpoint: Callable[[], None], db_path: Path, mailbox: str, endpoint: str
) -> None:
    """Confirm the endpoint is on disk, in the main file, before it's removed."""
    checkpoint()
    _, canary = endpoint.rsplit("/", 1)
    assert canary.encode() in sqlite_files(db_path)["relay.db"]
    assert [row[:2] for row in push_rows(db_path)] == [(mailbox, endpoint)]


def test_a_deleted_endpoint_leaves_no_trace_after_the_purge(
    push_client: TestClient, push_app: Any, db_path: Path, clock: FakeClock
) -> None:
    """secure_delete zeroes the row and the purge's checkpoint empties the WAL."""
    mailbox, (endpoint, _) = mailbox_id(), _canary_endpoint()
    subscribe(push_client, mailbox, endpoint)
    store = store_of(push_app)
    _stored(store.checkpoint, db_path, mailbox, endpoint)

    unsubscribe(push_client, mailbox, endpoint)
    purge(store, clock())

    _no_trace(db_path, endpoint)


def test_an_expired_endpoint_leaves_no_trace_after_the_purge(
    push_client: TestClient, push_app: Any, db_path: Path, clock: FakeClock
) -> None:
    """Thirty days on, the purge removes the row and every copy of it."""
    mailbox, (endpoint, _) = mailbox_id(), _canary_endpoint()
    subscribe(push_client, mailbox, endpoint)
    store = store_of(push_app)
    _stored(store.checkpoint, db_path, mailbox, endpoint)

    purge(store, clock.now + 31 * DAY)

    assert push_rows(db_path) == []
    _no_trace(db_path, endpoint)


def test_a_gone_endpoint_leaves_no_trace_after_the_purge(
    push_settings: Settings,
    clock: FakeClock,
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 410 deletes the row; the purge then clears the WAL of it.

    The tick runs on the app's event loop, so the test touches the store
    only through that loop too.
    """
    endpoint, _ = _canary_endpoint()
    service = _Service({endpoint: 410})
    monkeypatch.setattr(push, "TICK_SECONDS", 0.01)
    relay, _ = _push_relay(push_settings, clock, service)
    store = store_of(relay)
    mailbox = mailbox_id()
    try:
        with TestClient(relay) as client:
            portal = client.portal
            assert portal is not None
            subscribe(client, mailbox, endpoint)
            _stored(lambda: portal.call(store.checkpoint), db_path, mailbox, endpoint)
            wake_put(client, mailbox)
            _wait_for(lambda: push_rows(db_path) == [])
            portal.call(purge, store, clock())
            _no_trace(db_path, endpoint)
    finally:
        store.close()


def test_push_requests_from_many_addresses_leave_no_address(
    push_app: Any, db_path: Path, logged: Any
) -> None:
    """The push routes sit behind the same middleware: no client address lands."""
    needles = [CANARY, *CLIENT_ADDRESSES]
    for address in CLIENT_ADDRESSES:
        client = TestClient(push_app, client=(address, 41000))
        mailbox, (endpoint, _) = mailbox_id(), _canary_endpoint()
        responses = [
            client.get("/v1/push/key", headers=CANARY_HEADERS),
            client.put(
                f"/v1/push/{mailbox}",
                json={"endpoint": endpoint},
                headers=CANARY_HEADERS,
            ),
            client.post(
                f"/v1/push/{mailbox}/nudge",
                json={"not_before": 0},
                headers=CANARY_HEADERS,
            ),
        ]
        for response in responses:
            assert response.status_code in {200, 204}
            assert _found(response.content, needles) == []

    for name, data in sqlite_files(db_path).items():
        assert _found(data, needles) == [], name
    assert _found(logged(), needles) == []


def test_the_vapid_key_never_reaches_the_database_or_output(
    push_client: TestClient, vapid_key: Path, db_path: Path, logged: Any
) -> None:
    """Only the public half leaves the key file, and only in its own route."""
    pem_body = b"".join(vapid_key.read_bytes().splitlines()[1:-1]).decode()
    public = push_client.get("/v1/push/key").json()["vapid_public_key"]
    subscribe(push_client, mailbox_id(), _canary_endpoint()[0])

    needles = [pem_body[:32], pem_body[-32:]]
    for name, data in sqlite_files(db_path).items():
        assert _found(data, [*needles, public]) == [], name
    assert _found(logged(), needles) == []
