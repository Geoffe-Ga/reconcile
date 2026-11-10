"""The one request the relay makes: an empty, VAPID-signed POST (RFC 8030, 8292).

``httpx2.MockTransport`` stands in for the push services, so nothing here
leaves the machine.
"""

from __future__ import annotations

import asyncio
import base64
import re
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import httpx2
import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from py_vapid.jwt import decode

from reconcile.relay import push
from reconcile.relay.push import WebPushSender, load_vapid, run_due
from reconcile.relay.settings import Settings
from reconcile.relay.store import BlobStore
from tests.relay.helpers import (
    SUBJECT,
    FakeClock,
    mailbox_id,
    push_endpoint,
    push_rows,
    write_vapid_key,
)

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from reconcile.relay.push import VapidKey

Handler = Callable[[httpx2.Request], Any]
B64URL = r"[A-Za-z0-9_-]"
AUTHORIZATION = re.compile(
    rf"vapid t=({B64URL}+\.{B64URL}+\.{B64URL}+),k=({B64URL}{{87}})"
)
HEADERS = {"ttl": "86400", "urgency": "normal", "topic": "reconcile"}
TWELVE_HOURS = 12 * 3600


@pytest.fixture
def vapid(tmp_path: Path, db_path: Path) -> VapidKey:
    """The relay's key, loaded the way ``create_app`` loads it."""
    key = tmp_path / "vapid.pem"
    write_vapid_key(key)
    loaded = load_vapid(Settings(db_path=db_path, vapid_key=key, vapid_subject=SUBJECT))
    assert loaded is not None
    return loaded


@pytest.fixture
def store(db_path: Path) -> Iterator[BlobStore]:
    """A store for the run_due checks."""
    created = BlobStore(db_path)
    yield created
    created.close()


class Service:
    """A fake push service: answers from a handler and keeps every request."""

    def __init__(self, handler: Handler | None = None) -> None:
        """Answer 201 unless ``handler`` says otherwise."""
        self.requests: list[httpx2.Request] = []
        self.handler = handler

    def __call__(self, request: httpx2.Request) -> Any:
        """Record the request, then answer it."""
        self.requests.append(request)
        if self.handler is None:
            return httpx2.Response(201)
        return self.handler(request)


def _send(
    vapid: VapidKey, clock: FakeClock, service: Service, *endpoints: str
) -> list[int]:
    """Send to each endpoint through a fresh sender, then close it."""

    async def run() -> list[int]:
        """Send in order and collect the statuses."""
        sender = WebPushSender(vapid, clock, transport=httpx2.MockTransport(service))
        try:
            return [await sender.send(endpoint) for endpoint in endpoints]
        finally:
            await sender.aclose()

    return asyncio.run(run())


def _claims(request: httpx2.Request) -> tuple[dict[str, Any], str]:
    """The verified JWT claims of a request, and the key it names."""
    match = AUTHORIZATION.fullmatch(request.headers["authorization"])
    assert match is not None, request.headers["authorization"]
    token, key = match.groups()
    return decode(token, key), key


def test_a_push_is_an_empty_post_with_exactly_these_headers(
    vapid: VapidKey, clock: FakeClock
) -> None:
    """No body, and no header beyond Host, Content-Length, the three and VAPID's."""
    service = Service()
    endpoint = push_endpoint()

    assert _send(vapid, clock, service, endpoint) == [201]

    (request,) = service.requests
    assert request.method == "POST"
    assert str(request.url) == endpoint
    assert request.content == b""
    assert sorted(request.headers.keys()) == sorted(
        ["host", "content-length", "ttl", "urgency", "topic", "authorization"]
    )
    assert request.headers["content-length"] == "0"
    assert request.headers["host"] == "web.push.apple.com"
    assert {name: request.headers[name] for name in HEADERS} == HEADERS


def test_the_jwt_names_the_endpoints_origin_the_subject_and_a_near_expiry(
    vapid: VapidKey, clock: FakeClock
) -> None:
    """``aud`` is the push service's origin; ``exp`` is 12 hours from relay time."""
    service = Service()

    _send(vapid, clock, service, "https://fcm.googleapis.com:443/fcm/send/abc")

    claims, key = _claims(service.requests[0])
    assert claims == {
        "aud": "https://fcm.googleapis.com",
        "sub": SUBJECT,
        "exp": int(clock.now) + TWELVE_HOURS,
    }
    assert 0 < claims["exp"] - clock.now <= TWELVE_HOURS
    assert key == vapid.public_key


def test_the_jwt_verifies_under_the_public_key_the_relay_serves(
    vapid: VapidKey, clock: FakeClock, tmp_path: Path
) -> None:
    """``k`` is the served key, and a token signed by another key fails under it."""
    service = Service()
    _send(vapid, clock, service, push_endpoint())
    match = AUTHORIZATION.fullmatch(service.requests[0].headers["authorization"])
    assert match is not None
    token, _ = match.groups()
    other = (
        write_vapid_key(tmp_path / "other.pem")
        .public_key()
        .public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    )
    other_key = base64.urlsafe_b64encode(other).rstrip(b"=").decode()

    assert decode(token, vapid.public_key)["sub"] == SUBJECT
    with pytest.raises(InvalidSignature):
        decode(token, other_key)


def test_each_push_is_signed_for_its_own_service(
    vapid: VapidKey, clock: FakeClock
) -> None:
    """Two services, two audiences, signed at each send's own time."""
    service = Service()
    apple, mozilla = push_endpoint(), push_endpoint("updates.push.services.mozilla.com")

    _send(vapid, clock, service, apple, mozilla)

    audiences = [_claims(request)[0]["aud"] for request in service.requests]
    assert audiences == [
        "https://web.push.apple.com",
        "https://updates.push.services.mozilla.com",
    ]


def test_a_redirect_is_not_followed(vapid: VapidKey, clock: FakeClock) -> None:
    """A 301 is an answer like any other: the relay makes no second request."""
    service = Service(
        lambda _: httpx2.Response(301, headers={"location": "https://evil.example/x"})
    )

    assert _send(vapid, clock, service, push_endpoint()) == [301]

    assert len(service.requests) == 1


def test_a_redirect_keeps_the_row(
    vapid: VapidKey, clock: FakeClock, store: BlobStore, db_path: Path
) -> None:
    """Through run_due, a 301 neither deletes the row nor reaches the new host."""
    service = Service(
        lambda _: httpx2.Response(301, headers={"location": "https://evil.example/x"})
    )
    mailbox, endpoint = mailbox_id(), push_endpoint()
    store.subscribe(mailbox, endpoint, expiry=10**6, keep=100)
    store.add_nudge(mailbox, 0, limit=50)

    async def run() -> None:
        """One run_due through a real sender on the fake service."""
        sender = WebPushSender(vapid, clock, transport=httpx2.MockTransport(service))
        try:
            await run_due(store, sender, clock())
        finally:
            await sender.aclose()

    asyncio.run(run())

    assert [str(request.url) for request in service.requests] == [endpoint]
    assert [row[1] for row in push_rows(db_path)] == [endpoint]


def test_an_endpoint_off_the_push_hosts_is_never_sent_to(
    vapid: VapidKey, clock: FakeClock
) -> None:
    """The sender checks the host again, so a stray row can't aim the relay."""
    service = Service()

    with pytest.raises(push.EndpointRejectedError):
        _send(vapid, clock, service, "https://evil.example/x")

    assert service.requests == []


def test_a_cookie_from_a_push_service_is_never_sent_back(
    vapid: VapidKey, clock: FakeClock
) -> None:
    """Pushes stay unlinkable to each other: no cookie jar carries a value over."""
    service = Service(
        lambda _: httpx2.Response(201, headers={"set-cookie": "track=me; Path=/"})
    )
    endpoint = push_endpoint()

    _send(vapid, clock, service, endpoint, endpoint)

    assert [request.headers.get("cookie") for request in service.requests] == [
        None,
        None,
    ]


def test_the_client_follows_no_redirect_and_times_out_fast(
    vapid: VapidKey, clock: FakeClock
) -> None:
    """5 s to connect, 10 s for each read or write, no redirects, no environment."""

    async def config() -> httpx2.AsyncClient:
        """The sender's client, as built."""
        sender = WebPushSender(vapid, clock)
        await sender.aclose()
        return sender.client

    client = asyncio.run(config())

    assert client.follow_redirects is False
    assert client.timeout == httpx2.Timeout(10.0, connect=5.0)
    assert client.trust_env is False


def test_a_send_that_hangs_is_cut_off_at_the_total_timeout(
    vapid: VapidKey, clock: FakeClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A service that never answers costs at most TOTAL_SECONDS per push."""
    monkeypatch.setattr(push, "TOTAL_SECONDS", 0.05)

    async def stall(_: httpx2.Request) -> httpx2.Response:
        """Answer far too late."""
        await asyncio.sleep(5)
        return httpx2.Response(201)

    with pytest.raises(TimeoutError):
        _send(vapid, clock, Service(stall), push_endpoint())


def test_the_response_body_is_never_read(vapid: VapidKey, clock: FakeClock) -> None:
    """The status is all the relay wants; a body it never reads can't fill memory."""
    read: list[bytes] = []

    class Endless(httpx2.AsyncByteStream):
        """A body that would never end, noting each chunk asked for."""

        async def __aiter__(self) -> Any:
            """Yield chunks forever."""
            while True:
                read.append(b"x")
                yield b"x" * 65536

    service = Service(lambda _: httpx2.Response(201, stream=Endless()))

    assert _send(vapid, clock, service, push_endpoint()) == [201]
    assert read == []
