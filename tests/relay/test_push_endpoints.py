"""Which push endpoints the relay will store, and so ever call (#89).

An endpoint is the one URL the relay will POST to on a device's behalf, so
it is held to the browsers' push services and nothing else: anything that
could point the relay at another host gets the same 422 and stores nothing.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from reconcile.relay.push import endpoint_origin
from tests.relay.helpers import (
    DAY,
    mailbox_id,
    push_endpoint,
    push_rows,
    subscribe,
)

if TYPE_CHECKING:
    from pathlib import Path

    from starlette.testclient import TestClient

    from tests.relay.helpers import FakeClock

REJECTED = b'{"error":"push_endpoint_rejected"}'
TOKEN = "a-device-token"

REFUSED = {
    "http": f"http://web.push.apple.com/{TOKEN}",
    "port 8443": f"https://web.push.apple.com:8443/{TOKEN}",
    "port 80": f"https://web.push.apple.com:80/{TOKEN}",
    "port 0443": f"https://web.push.apple.com:0443/{TOKEN}",
    "empty port": f"https://web.push.apple.com:/{TOKEN}",
    "IPv4 literal": f"https://17.188.128.1/{TOKEN}",
    "IPv4 loopback": f"https://127.0.0.1/{TOKEN}",
    "IPv6 literal": f"https://[2001:db8::1]/{TOKEN}",
    "IPv6 loopback": f"https://[::1]/{TOKEN}",
    "userinfo": f"https://someone@web.push.apple.com/{TOKEN}",
    "userinfo with a colon": f"https://someone:@web.push.apple.com/{TOKEN}",
    "userinfo, empty": f"https://@web.push.apple.com/{TOKEN}",
    "bare push.apple.com": f"https://push.apple.com/{TOKEN}",
    "evilpush.apple.com": f"https://evilpush.apple.com/{TOKEN}",
    "suffix on another host": f"https://web.push.apple.com.evil.example/{TOKEN}",
    "bare notify.windows.com": f"https://notify.windows.com/{TOKEN}",
    "evilnotify.windows.com": f"https://evilnotify.windows.com/{TOKEN}",
    "lookalike FCM": f"https://fcm.googleapis.com.evil.example/{TOKEN}",
    "FCM sibling": f"https://evil.googleapis.com/{TOKEN}",
    "Mozilla parent": f"https://push.services.mozilla.com/{TOKEN}",
    "trailing dot": f"https://web.push.apple.com./{TOKEN}",
    "upper-case host": f"https://WEB.PUSH.APPLE.COM/{TOKEN}",
    "upper-case scheme": f"HTTPS://web.push.apple.com/{TOKEN}",
    "fragment": f"https://web.push.apple.com/{TOKEN}#frag",
    "backslash host trick": f"https://evil.example\\.web.push.apple.com/{TOKEN}",
    "backslash in path": f"https://web.push.apple.com/{TOKEN}\\x",
    "space": f"https://web.push.apple.com/{TOKEN} x",
    "newline": f"https://web.push.apple.com/{TOKEN}\n",
    "tab in host": f"https://web.push.apple.com\t/{TOKEN}",
    "non-ASCII path": f"https://web.push.apple.com/{TOKEN}é",
    "non-ASCII host": f"https://wéb.push.apple.com/{TOKEN}",
    "percent in host": f"https://web%2epush.apple.com/{TOKEN}",
    "no scheme": f"web.push.apple.com/{TOKEN}",
    "scheme-relative": f"//web.push.apple.com/{TOKEN}",
    "query straight after host": f"https://web.push.apple.com?{TOKEN}",
    "empty": "",
    "1,025 bytes": "https://web.push.apple.com/"
    + "a" * (1025 - len("https://web.push.apple.com/")),
}

ACCEPTED = {
    "Apple": f"https://web.push.apple.com/{TOKEN}",
    "Apple subdomain": f"https://api.push.apple.com/{TOKEN}",
    "FCM": f"https://fcm.googleapis.com/fcm/send/abc:{TOKEN}",
    "FCM on port 443": f"https://fcm.googleapis.com:443/fcm/send/{TOKEN}",
    "Mozilla": f"https://updates.push.services.mozilla.com/wpush/v2/{TOKEN}",
    "WNS": f"https://wns2-by3p.notify.windows.com/w/?token={TOKEN}%3d%3d",
    "no path": "https://web.push.apple.com",
    "1,024 bytes": "https://web.push.apple.com/"
    + "a" * (1024 - len("https://web.push.apple.com/")),
}


@pytest.mark.parametrize("endpoint", REFUSED.values(), ids=REFUSED.keys())
def test_an_endpoint_off_the_push_hosts_gets_the_same_422_and_no_row(
    push_client: TestClient, db_path: Path, endpoint: str
) -> None:
    """Every refusal looks the same and leaves nothing behind."""
    response = subscribe(push_client, mailbox_id(), endpoint)

    assert response.status_code == 422
    assert response.content == REJECTED
    assert push_rows(db_path) == []


@pytest.mark.parametrize("endpoint", ACCEPTED.values(), ids=ACCEPTED.keys())
def test_an_endpoint_on_the_push_hosts_is_stored(
    push_client: TestClient, db_path: Path, endpoint: str
) -> None:
    """Apple, Google, Mozilla and Microsoft endpoints are kept as sent."""
    mailbox = mailbox_id()

    response = subscribe(push_client, mailbox, endpoint)

    assert response.status_code == 204
    assert response.content == b""
    assert [row[:2] for row in push_rows(db_path)] == [(mailbox, endpoint)]


@pytest.mark.parametrize(
    ("endpoint", "origin"),
    [
        (ACCEPTED["Apple"], "https://web.push.apple.com"),
        (ACCEPTED["FCM on port 443"], "https://fcm.googleapis.com"),
        (ACCEPTED["WNS"], "https://wns2-by3p.notify.windows.com"),
        (ACCEPTED["no path"], "https://web.push.apple.com"),
    ],
)
def test_the_origin_is_the_scheme_and_host_alone(endpoint: str, origin: str) -> None:
    """The VAPID audience drops the default port and everything after the host."""
    assert endpoint_origin(endpoint) == origin


@pytest.mark.parametrize("endpoint", REFUSED.values(), ids=REFUSED.keys())
def test_a_refused_endpoint_has_no_origin(endpoint: str) -> None:
    """The sender asks the same question before it sends, and gets no host."""
    assert endpoint_origin(endpoint) is None


# --- Expiry and the per-mailbox cap ------------------------------------------


def _expiries(db_path: Path) -> dict[str, int]:
    """Each stored endpoint's expiry day."""
    return {endpoint: expiry for _, endpoint, expiry in push_rows(db_path)}


def test_a_subscription_is_kept_thirty_days_rounded_up(
    push_client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """Expiry follows the blob rule: receipt day + 30 + 1."""
    subscribe(push_client, mailbox_id(), push_endpoint())

    ((_, _, expiry),) = push_rows(db_path)

    assert expiry == int(clock.now) // DAY + 31


def test_a_re_put_refreshes_the_expiry(
    push_client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """Upkeep re-PUTs the same endpoint, which moves its expiry, not adds a row."""
    mailbox, endpoint = mailbox_id(), push_endpoint()
    subscribe(push_client, mailbox, endpoint)
    clock.advance(7 * DAY)

    assert subscribe(push_client, mailbox, endpoint).status_code == 204

    assert push_rows(db_path) == [(mailbox, endpoint, int(clock.now) // DAY + 31)]


def test_the_same_endpoint_in_two_mailboxes_is_two_rows(
    push_client: TestClient, db_path: Path
) -> None:
    """One phone in two groups: one row per mailbox (ADR-0075 §2)."""
    first, second, endpoint = mailbox_id(), mailbox_id(), push_endpoint()
    subscribe(push_client, first, endpoint)
    subscribe(push_client, second, endpoint)

    assert sorted(row[:2] for row in push_rows(db_path)) == sorted(
        [(first, endpoint), (second, endpoint)]
    )


def test_the_101st_endpoint_evicts_the_soonest_expiry(
    push_client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """A mailbox keeps at most 100 endpoints, dropping the one expiring first."""
    mailbox = mailbox_id()
    oldest = push_endpoint(path="oldest")
    subscribe(push_client, mailbox, oldest)
    clock.advance(DAY)
    others = [push_endpoint(path=f"device-{n:02}") for n in range(99)]
    for endpoint in others:
        assert subscribe(push_client, mailbox, endpoint).status_code == 204
    assert len(push_rows(db_path)) == 100
    clock.advance(DAY)
    newest = push_endpoint(path="newest")

    assert subscribe(push_client, mailbox, newest).status_code == 204

    assert set(_expiries(db_path)) == {*others, newest}


def test_eviction_never_takes_the_endpoint_just_put(
    push_client: TestClient, db_path: Path
) -> None:
    """On a tie (all 101 put today), the newcomer stays and one other goes."""
    mailbox = mailbox_id()
    for n in range(100):
        subscribe(push_client, mailbox, push_endpoint(path=f"device-{n:03}"))
    newest = push_endpoint(path="newest")

    subscribe(push_client, mailbox, newest)

    kept = _expiries(db_path)
    assert len(kept) == 100
    assert newest in kept


def test_a_re_put_at_the_cap_evicts_nothing(
    push_client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """Refreshing one of the 100 doesn't make room by dropping another."""
    mailbox = mailbox_id()
    endpoints = [push_endpoint(path=f"device-{n:03}") for n in range(100)]
    for endpoint in endpoints:
        subscribe(push_client, mailbox, endpoint)
    clock.advance(DAY)

    subscribe(push_client, mailbox, endpoints[0])

    assert set(_expiries(db_path)) == set(endpoints)


def test_the_cap_is_per_mailbox(push_client: TestClient, db_path: Path) -> None:
    """Another mailbox's endpoints don't count toward this one's 100."""
    crowded, other = mailbox_id(), mailbox_id()
    for n in range(100):
        subscribe(push_client, crowded, push_endpoint(path=f"device-{n:03}"))
    subscribe(push_client, other, push_endpoint(path="other"))

    assert len(push_rows(db_path)) == 101
