"""Wakes and nudges: who gets an empty push, and when (#89).

Every test drives ``run_due`` itself on a fake clock, with a sender that
records endpoints instead of calling a push service.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, Any, ClassVar

import pytest
from starlette.testclient import TestClient

from reconcile.relay import push
from reconcile.relay.app import create_app
from reconcile.relay.purge import purge
from reconcile.relay.settings import Settings
from tests.relay.helpers import (
    DAY,
    MINUTE,
    FakeClock,
    FakeSender,
    blob,
    call,
    mailbox_id,
    nudge,
    nudge_rows,
    push_endpoint,
    push_rows,
    put,
    row_count,
    store_of,
    subscribe,
    tick,
    unsubscribe,
    wake_put,
)

if TYPE_CHECKING:
    from pathlib import Path

    from starlette.types import ASGIApp

HORIZON = 43_200  # minutes: 30 days


def _minute(clock: FakeClock) -> int:
    """The relay minute the fake clock reads."""
    return int(clock.now) // MINUTE


def _subscribed(client: TestClient, mailbox: str, count: int) -> list[str]:
    """Register ``count`` fresh endpoints under ``mailbox``."""
    endpoints = [push_endpoint() for _ in range(count)]
    for endpoint in endpoints:
        assert subscribe(client, mailbox, endpoint).status_code == 204
    return endpoints


# --- wake=1 ------------------------------------------------------------------


def test_wake_sends_once_to_each_live_endpoint_of_that_mailbox_only(
    push_client: TestClient, push_app: ASGIApp, sender: FakeSender, clock: FakeClock
) -> None:
    """A woken mailbox's endpoints each get one push; other mailboxes get none."""
    woken, quiet = mailbox_id(), mailbox_id()
    mine = _subscribed(push_client, woken, 2)
    _subscribed(push_client, quiet, 1)

    response = wake_put(push_client, woken)
    tick(push_client, push_app, sender, clock())

    assert response.status_code == 201
    assert set(response.json()) == {"seq"}
    assert sorted(sender.sent) == sorted(mine)


def test_two_wakes_in_one_minute_send_once(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
    db_path: Path,
) -> None:
    """Wakes in the same minute collapse into one nudge row and one push."""
    mailbox = mailbox_id()
    (endpoint,) = _subscribed(push_client, mailbox, 1)

    wake_put(push_client, mailbox)
    clock.advance(30)
    wake_put(push_client, mailbox)
    assert len(nudge_rows(db_path)) == 1
    tick(push_client, push_app, sender, clock())

    assert sender.sent == [endpoint]


def test_wakes_waiting_for_one_tick_send_once(
    push_client: TestClient, push_app: ASGIApp, sender: FakeSender, clock: FakeClock
) -> None:
    """Wakes in different minutes, taken by one tick, still push each device once."""
    mailbox = mailbox_id()
    (endpoint,) = _subscribed(push_client, mailbox, 1)
    wake_put(push_client, mailbox)
    clock.advance(MINUTE)
    wake_put(push_client, mailbox)

    tick(push_client, push_app, sender, clock())

    assert sender.sent == [endpoint]


def test_no_wake_no_send(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
    db_path: Path,
) -> None:
    """A blob PUT without ``wake`` stores the blob and schedules nothing."""
    mailbox = mailbox_id()
    _subscribed(push_client, mailbox, 1)

    assert put(push_client, mailbox, blob()).status_code == 201
    tick(push_client, push_app, sender, clock())

    assert nudge_rows(db_path) == []
    assert sender.sent == []


def test_a_wake_is_due_in_the_minute_the_blob_was_received(
    push_client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """The nudge is due now, in the blob's own ``received`` minute."""
    mailbox = mailbox_id()
    _subscribed(push_client, mailbox, 1)

    wake_put(push_client, mailbox)

    assert nudge_rows(db_path) == [(mailbox, _minute(clock))]


def test_a_wake_for_a_mailbox_with_no_live_endpoint_stores_nothing(
    push_client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """No device to wake means no record of which blob mattered."""
    lapsed, empty = mailbox_id(), mailbox_id()
    _subscribed(push_client, lapsed, 1)
    clock.advance(31 * DAY)  # the subscription has expired, unpurged

    wake_put(push_client, lapsed)
    wake_put(push_client, empty)

    assert nudge_rows(db_path) == []


def test_the_wake_is_added_only_after_the_blob_commits(
    push_app: ASGIApp, db_path: Path, push_client: TestClient
) -> None:
    """A PUT refused for its body leaves no nudge behind."""
    mailbox = mailbox_id()
    _subscribed(push_client, mailbox, 1)

    response = push_client.put(
        f"/v1/mailbox/{mailbox}",
        params={"wake": "1"},
        content=blob(1000),
        headers={"content-type": "application/octet-stream"},
    )

    assert response.status_code == 400
    assert row_count(db_path) == 0
    assert nudge_rows(db_path) == []


@pytest.mark.parametrize(
    "wake",
    ["0", "2", "true", "yes", "", " 1", "1 ", "01", "\u0661"],  # Arabic-Indic 1
)
def test_any_wake_but_1_is_a_400_and_stores_nothing(
    push_client: TestClient, db_path: Path, wake: str
) -> None:
    """``wake`` is ``1`` or absent; anything else is refused before the body."""
    mailbox = mailbox_id()
    _subscribed(push_client, mailbox, 1)

    response = wake_put(push_client, mailbox, wake=wake)

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_wake"}
    assert row_count(db_path) == 0
    assert nudge_rows(db_path) == []


# --- Scheduled nudges ----------------------------------------------------------


def test_a_nudge_sends_at_its_minute_not_before_then_is_gone(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
    db_path: Path,
) -> None:
    """ "Closing soon" goes out in its minute, once."""
    mailbox = mailbox_id()
    (endpoint,) = _subscribed(push_client, mailbox, 1)
    due = _minute(clock) + 10

    assert nudge(push_client, mailbox, due).status_code == 204
    tick(push_client, push_app, sender, (due - 1) * MINUTE + 59)
    assert sender.sent == []
    tick(push_client, push_app, sender, due * MINUTE)
    tick(push_client, push_app, sender, due * MINUTE + 15)

    assert sender.sent == [endpoint]
    assert nudge_rows(db_path) == []


def test_a_nudge_in_the_past_is_due_now(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
    db_path: Path,
) -> None:
    """A late ``not_before`` is stored as this minute, not the minute it named."""
    mailbox = mailbox_id()
    (endpoint,) = _subscribed(push_client, mailbox, 1)

    assert nudge(push_client, mailbox, _minute(clock) - 500).status_code == 204
    assert nudge(push_client, mailbox, 0).status_code == 204
    assert nudge_rows(db_path) == [(mailbox, _minute(clock))]
    tick(push_client, push_app, sender, clock())

    assert sender.sent == [endpoint]


def test_a_nudge_up_to_thirty_days_ahead_is_accepted(
    push_client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """``not_before`` may be as late as now + 43,200 minutes."""
    mailbox = mailbox_id()

    response = nudge(push_client, mailbox, _minute(clock) + HORIZON)

    assert response.status_code == 204
    assert nudge_rows(db_path) == [(mailbox, _minute(clock) + HORIZON)]


@pytest.mark.parametrize("offset", [HORIZON + 1, 10**12])
def test_a_nudge_past_thirty_days_is_a_400(
    push_client: TestClient, db_path: Path, clock: FakeClock, offset: int
) -> None:
    """Nothing is scheduled beyond the relay's 30-day retention."""
    response = nudge(push_client, mailbox_id(), _minute(clock) + offset)

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_not_before"}
    assert nudge_rows(db_path) == []


def test_a_negative_not_before_is_a_400(push_client: TestClient, db_path: Path) -> None:
    """Relay minutes start at the epoch."""
    response = nudge(push_client, mailbox_id(), -1)

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_not_before"}
    assert nudge_rows(db_path) == []


def test_the_51st_pending_nudge_is_a_429(
    push_client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """A mailbox holds at most 50 pending nudges; a repeat minute isn't a new one."""
    mailbox, other = mailbox_id(), mailbox_id()
    start = _minute(clock) + 60
    for n in range(50):
        assert nudge(push_client, mailbox, start + n).status_code == 204

    refused = nudge(push_client, mailbox, start + 50)
    repeat = nudge(push_client, mailbox, start + 49)
    elsewhere = nudge(push_client, other, start)

    assert refused.status_code == 429
    assert refused.json() == {"error": "too_many_nudges"}
    assert repeat.status_code == 204
    assert elsewhere.status_code == 204
    assert len(nudge_rows(db_path)) == 51


def test_a_wake_still_lands_at_the_nudge_cap(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
) -> None:
    """The cap limits scheduled nudges; a wake is due now and drains each tick."""
    mailbox = mailbox_id()
    (endpoint,) = _subscribed(push_client, mailbox, 1)
    for n in range(50):
        nudge(push_client, mailbox, _minute(clock) + 60 + n)

    assert wake_put(push_client, mailbox).status_code == 201
    tick(push_client, push_app, sender, clock())

    assert sender.sent == [endpoint]


# --- What a send's answer does to the row ------------------------------------


def test_a_410_deletes_only_its_row_and_a_500_keeps_it(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
    db_path: Path,
) -> None:
    """Gone endpoints go; a failing service gets no retry, and its row stays."""
    mailbox = mailbox_id()
    gone, failing, fine = _subscribed(push_client, mailbox, 3)
    sender.statuses = {gone: 410, failing: 500}

    wake_put(push_client, mailbox)
    tick(push_client, push_app, sender, clock())
    tick(push_client, push_app, sender, clock())

    assert sorted(sender.sent) == sorted([gone, failing, fine])
    assert {row[1] for row in push_rows(db_path)} == {failing, fine}


@pytest.mark.parametrize(
    ("status", "kept"),
    [(201, True), (202, True), (404, False), (410, False), (301, True), (429, True)],
)
def test_each_answer_keeps_or_drops_the_row(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
    db_path: Path,
    status: int,
    kept: bool,
) -> None:
    """Only 404 and 410 drop a row; everything else keeps it."""
    mailbox = mailbox_id()
    (endpoint,) = _subscribed(push_client, mailbox, 1)
    sender.statuses = {endpoint: status}

    wake_put(push_client, mailbox)
    tick(push_client, push_app, sender, clock())

    assert bool(push_rows(db_path)) is kept


def test_a_gone_endpoint_leaves_every_mailbox(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
    db_path: Path,
) -> None:
    """A 410 ends the subscription itself, so no mailbox keeps the dead address."""
    woken, other = mailbox_id(), mailbox_id()
    endpoint = push_endpoint()
    subscribe(push_client, woken, endpoint)
    subscribe(push_client, other, endpoint)
    sender.statuses = {endpoint: 410}

    wake_put(push_client, woken)
    tick(push_client, push_app, sender, clock())

    assert push_rows(db_path) == []


def test_one_phone_in_two_woken_groups_gets_one_push(
    push_client: TestClient, push_app: ASGIApp, sender: FakeSender, clock: FakeClock
) -> None:
    """Each endpoint is pushed once per tick, however many of its mailboxes woke."""
    first, second = mailbox_id(), mailbox_id()
    endpoint = push_endpoint()
    subscribe(push_client, first, endpoint)
    subscribe(push_client, second, endpoint)

    wake_put(push_client, first)
    wake_put(push_client, second)
    tick(push_client, push_app, sender, clock())

    assert sender.sent == [endpoint]


def test_a_raising_send_is_swallowed_and_the_others_still_go(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
    db_path: Path,
) -> None:
    """One unreachable service neither stops the tick nor loses its row."""
    mailbox = mailbox_id()
    broken, fine = _subscribed(push_client, mailbox, 2)
    sender.failing = {broken}

    wake_put(push_client, mailbox)
    tick(push_client, push_app, sender, clock())

    assert sorted(sender.sent) == sorted([broken, fine])
    assert {row[1] for row in push_rows(db_path)} == {broken, fine}


def test_an_expired_endpoint_is_skipped_then_purged(
    push_client: TestClient,
    push_app: ASGIApp,
    sender: FakeSender,
    clock: FakeClock,
    db_path: Path,
) -> None:
    """From its expiry day a row gets no push, and the next purge deletes it."""
    mailbox = mailbox_id()
    _subscribed(push_client, mailbox, 1)  # expires first
    clock.advance(10 * DAY)
    (fresh,) = _subscribed(push_client, mailbox, 1)
    clock.advance(21 * DAY)  # stale's expiry day; fresh has 10 days left

    wake_put(push_client, mailbox)
    tick(push_client, push_app, sender, clock())
    deleted = purge(store_of(push_app), clock())

    assert sender.sent == [fresh]
    assert deleted == 1
    assert [row[1] for row in push_rows(db_path)] == [fresh]


def test_the_purge_drops_nudges_left_over_a_day_late(
    push_client: TestClient, push_app: ASGIApp, db_path: Path, clock: FakeClock
) -> None:
    """A nudge the tick never took (push since turned off) doesn't linger."""
    mailbox = mailbox_id()
    nudge(push_client, mailbox, _minute(clock) + 1)
    nudge(push_client, mailbox, _minute(clock) + 2 * 1440)

    assert purge(store_of(push_app), clock.now + DAY) == 0
    assert purge(store_of(push_app), clock.now + 2 * DAY) == 1

    assert nudge_rows(db_path) == [(mailbox, _minute(clock) + 2 * 1440)]


# --- DELETE --------------------------------------------------------------------


def test_delete_removes_the_endpoint_from_that_mailbox_only(
    push_client: TestClient, db_path: Path
) -> None:
    """Turning one group off leaves the phone's other groups as they were."""
    first, second, endpoint = mailbox_id(), mailbox_id(), push_endpoint()
    subscribe(push_client, first, endpoint)
    subscribe(push_client, second, endpoint)

    response = unsubscribe(push_client, first, endpoint)

    assert response.status_code == 204
    assert [row[:2] for row in push_rows(db_path)] == [(second, endpoint)]


@pytest.mark.parametrize(
    "endpoint",
    [push_endpoint(path="never-stored"), "https://evil.example/x", "", "x" * 1500],
    ids=["unknown", "off the list", "empty", "too long"],
)
def test_delete_is_always_204(push_client: TestClient, endpoint: str) -> None:
    """Whether or not the row existed, or could, a DELETE says the same."""
    assert unsubscribe(push_client, mailbox_id(), endpoint).status_code == 204


# --- Request checks --------------------------------------------------------------

JSON = {"content-type": "application/json"}


def _routes(mailbox: str) -> list[tuple[str, str, dict[str, Any]]]:
    """Each JSON push route with a valid body."""
    return [
        ("PUT", f"/v1/push/{mailbox}", {"endpoint": push_endpoint()}),
        ("DELETE", f"/v1/push/{mailbox}", {"endpoint": push_endpoint()}),
        ("POST", f"/v1/push/{mailbox}/nudge", {"not_before": 0}),
    ]


ROUTE_IDS = ["subscribe", "unsubscribe", "nudge"]


@pytest.mark.parametrize("index", range(3), ids=ROUTE_IDS)
@pytest.mark.parametrize(
    "mailbox", ["A" * 42, "A" * 44, "A" * 42 + "+", "A" * 42 + "="]
)
def test_a_malformed_mailbox_is_refused(
    push_client: TestClient, db_path: Path, index: int, mailbox: str
) -> None:
    """The push routes take the same 43-character ids as the mailbox."""
    method, path, body = _routes(mailbox)[index]

    response = push_client.request(method, path, json=body)

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_mailbox"}
    assert push_rows(db_path) == []
    assert nudge_rows(db_path) == []


@pytest.mark.parametrize("index", range(3), ids=ROUTE_IDS)
@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"null",
        b"[]",
        b'"x"',
        b"{}",
        b"{",
        b"not json",
        b'{"endpoint": 1, "not_before": "x"}',
        b'{"endpoint": "https://web.push.apple.com/a", "extra": 1}',
        b'{"not_before": 0, "extra": 1}',
        b'{"endpoint": "https://web.push.apple.com/a", '
        b'"keys": {"p256dh": "k", "auth": "a"}}',
        b'{"endpoint": "https://web.push.apple.com/a", '
        b'"endpoint": "https://web.push.apple.com/b"}',
        b'{"not_before": 1, "not_before": 2}',
        b'{"endpoint": null}',
        b'{"endpoint": ["https://web.push.apple.com/a"]}',
        b'{"not_before": 1.0}',
        b'{"not_before": "1"}',
        b'{"not_before": true}',
        b'{"not_before": NaN}',
        b'{"not_before": 1e3}',
        b"\xff\xfe{\x00}\x00",
        '{"endpoint": "https://web.push.apple.com/a"}'.encode("utf-16"),
        b"[" * 1024 + b"]" * 1024,
        b'{"endpoint":' + b"[" * 1010 + b"]" * 1010 + b"}",
    ],
)
def test_a_body_outside_the_closed_schema_is_a_400(
    push_client: TestClient, db_path: Path, index: int, raw: bytes
) -> None:
    """Each body is one JSON object holding exactly its one key, of its type."""
    method, path, _ = _routes(mailbox_id())[index]
    headers = {**JSON, "content-length": str(len(raw))}  # even for an empty DELETE

    response = push_client.request(method, path, content=raw, headers=headers)

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_request"}
    assert push_rows(db_path) == []
    assert nudge_rows(db_path) == []


@pytest.mark.parametrize("index", range(3), ids=ROUTE_IDS)
@pytest.mark.parametrize(
    "content_type", [None, "text/plain", "application/x-www-form-urlencoded"]
)
def test_a_body_that_isnt_json_is_a_415(
    push_client: TestClient, index: int, content_type: str | None
) -> None:
    """The routes take ``application/json`` only, so no plain form can call them."""
    method, path, body = _routes(mailbox_id())[index]
    headers = {} if content_type is None else {"content-type": content_type}

    response = push_client.request(
        method, path, content=json.dumps(body).encode(), headers=headers
    )

    assert response.status_code == 415
    assert response.json() == {"error": "unsupported_media_type"}


@pytest.mark.parametrize("index", range(3), ids=ROUTE_IDS)
def test_json_with_parameters_is_accepted(push_client: TestClient, index: int) -> None:
    """The media type is matched like the mailbox's: any case, with parameters."""
    method, path, body = _routes(mailbox_id())[index]

    response = push_client.request(
        method,
        path,
        content=json.dumps(body).encode(),
        headers={"content-type": "Application/JSON; charset=utf-8"},
    )

    assert response.status_code == 204


def _raw(
    app: ASGIApp, method: str, path: str, length: bytes | None, body: bytes
) -> tuple[int, bytes, list[dict[str, Any]]]:
    """Call ``app`` directly, recording which body messages it asked for."""
    given: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        """Hand over the body in one message, noting the request for it."""
        message = {"type": "http.request", "body": body, "more_body": False}
        given.append(message)
        return message

    headers = [(b"content-type", b"application/json")]
    if length is not None:
        headers.append((b"content-length", length))
    result = asyncio.run(call(app, method, path, receive=receive, headers=headers))
    return result.status, result.body, given


@pytest.mark.parametrize("index", range(3), ids=ROUTE_IDS)
@pytest.mark.parametrize(
    ("length", "status", "body"),
    [
        (b"2049", 413, b'{"error":"too_large"}'),
        (b"9" * 30, 413, b'{"error":"too_large"}'),
        (None, 411, b'{"error":"length_required"}'),
        (b"abc", 400, b'{"error":"invalid_length"}'),
        (b"-1", 400, b'{"error":"invalid_length"}'),
    ],
)
def test_content_length_is_checked_before_the_body_is_read(
    push_app: ASGIApp,
    db_path: Path,
    index: int,
    length: bytes | None,
    status: int,
    body: bytes,
) -> None:
    """At most 2,048 bytes, declared up front, or not a byte is read."""
    method, path, payload = _routes(mailbox_id())[index]

    got_status, got_body, given = _raw(
        push_app, method, path, length, json.dumps(payload).encode()
    )

    assert (got_status, got_body) == (status, body)
    assert given == []
    assert push_rows(db_path) == []
    assert nudge_rows(db_path) == []


def test_a_2048_byte_body_is_read(push_client: TestClient, db_path: Path) -> None:
    """The cap is inclusive: a padded 2,048-byte body is parsed."""
    mailbox, endpoint = mailbox_id(), push_endpoint()
    raw = json.dumps({"endpoint": endpoint}).encode()
    raw += b" " * (2048 - len(raw))

    response = push_client.put(f"/v1/push/{mailbox}", content=raw, headers=JSON)

    assert response.status_code == 204
    assert [row[:2] for row in push_rows(db_path)] == [(mailbox, endpoint)]


@pytest.mark.parametrize("index", [0, 2], ids=["subscribe", "nudge"])
def test_storage_full_refuses_push_writes(
    push_client: TestClient,
    push_app: ASGIApp,
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    index: int,
) -> None:
    """Push PUTs and nudges get the blob PUT's 507 once the database is full."""
    store = store_of(push_app)
    monkeypatch.setattr(store, "size_bytes", lambda: Settings(db_path).max_db_bytes + 1)
    method, path, body = _routes(mailbox_id())[index]

    response = push_client.request(method, path, json=body)

    assert response.status_code == 507
    assert response.json() == {"error": "storage_full"}
    assert push_rows(db_path) == []
    assert nudge_rows(db_path) == []


def test_storage_full_still_allows_a_delete(
    push_client: TestClient,
    push_app: ASGIApp,
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deleting frees space, so a full relay still forgets an endpoint."""
    mailbox, endpoint = mailbox_id(), push_endpoint()
    subscribe(push_client, mailbox, endpoint)
    store = store_of(push_app)
    monkeypatch.setattr(store, "size_bytes", lambda: Settings(db_path).max_db_bytes + 1)

    assert unsubscribe(push_client, mailbox, endpoint).status_code == 204
    assert push_rows(db_path) == []


def test_the_push_routes_take_only_their_methods(push_client: TestClient) -> None:
    """GET a mailbox's push route, or PUT its nudge, is a plain 405."""
    mailbox = mailbox_id()

    assert push_client.get(f"/v1/push/{mailbox}").status_code == 405
    assert push_client.put(f"/v1/push/{mailbox}/nudge", json={}).status_code == 405
    assert push_client.post("/v1/push/key").status_code == 405


# --- The tick ----------------------------------------------------------------------


def _wait_for(condition: Any, seconds: float = 10) -> None:
    """Poll ``condition`` until it holds, or fail."""
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            pytest.fail("the condition never held")
        time.sleep(0.01)


def test_the_lifespan_tick_sends_and_shutdown_closes_the_sender(
    push_settings: Settings,
    clock: FakeClock,
    sender: FakeSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The relay runs ``run_due`` on its own, and closes its sender on the way out."""
    monkeypatch.setattr(push, "TICK_SECONDS", 0.01)
    relay = create_app(push_settings, clock, sender=sender)
    mailbox, endpoint = mailbox_id(), push_endpoint()
    try:
        with TestClient(relay) as client:
            subscribe(client, mailbox, endpoint)
            wake_put(client, mailbox)
            _wait_for(lambda: sender.sent == [endpoint])
            assert not sender.closed
    finally:
        store_of(relay).close()

    assert sender.closed


class _LockedError(RuntimeError):
    """What SQLite raises while the purge holds the write lock."""

    def __init__(self) -> None:
        """Say so."""
        super().__init__("database is locked")


def test_the_tick_keeps_going_after_a_failing_run(
    push_settings: Settings,
    clock: FakeClock,
    sender: FakeSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A run that raises (a locked database, say) is swallowed; the next one runs."""
    runs: list[float] = []
    real_run_due = push.run_due

    async def flaky(*args: Any) -> None:
        """Fail the first run, then behave."""
        runs.append(args[2])
        if len(runs) == 1:
            raise _LockedError
        await real_run_due(*args)

    monkeypatch.setattr(push, "TICK_SECONDS", 0.01)
    monkeypatch.setattr(push, "run_due", flaky)
    relay = create_app(push_settings, clock, sender=sender)
    mailbox, endpoint = mailbox_id(), push_endpoint()
    try:
        with TestClient(relay) as client:
            subscribe(client, mailbox, endpoint)
            wake_put(client, mailbox)
            _wait_for(lambda: sender.sent == [endpoint])
    finally:
        store_of(relay).close()

    assert len(runs) >= 2


class _RecordingSender:
    """Stands in for WebPushSender, noting how the relay built and closed it."""

    built: ClassVar[list[tuple[Any, ...]]] = []
    closed: ClassVar[int] = 0

    def __init__(self, *args: Any) -> None:
        """Note the arguments."""
        type(self).built.append(args)

    async def send(self, endpoint: str) -> int:
        """Never called here."""
        raise AssertionError(endpoint)

    async def aclose(self) -> None:
        """Note the close."""
        type(self).closed += 1


def test_create_app_builds_a_web_push_sender_by_default(
    push_settings: Settings, clock: FakeClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without an injected sender, the relay makes its own from its key and clock."""
    monkeypatch.setattr(_RecordingSender, "built", [])
    monkeypatch.setattr(_RecordingSender, "closed", 0)
    monkeypatch.setattr(push, "WebPushSender", _RecordingSender)
    relay = create_app(push_settings, clock)
    try:
        with TestClient(relay) as client:
            key = client.get("/v1/push/key").json()["vapid_public_key"]
    finally:
        store_of(relay).close()

    ((vapid, given_clock),) = _RecordingSender.built
    assert vapid.public_key == key
    assert vapid.subject == push_settings.vapid_subject
    assert given_clock is clock
    assert _RecordingSender.closed == 1
