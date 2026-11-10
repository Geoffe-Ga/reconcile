"""One mailbox can't fill the relay for every group: each has a byte cap (#141).

Once a mailbox's unexpired blobs plus the incoming one would pass
``max_mailbox_bytes``, a PUT gets ``507 {"error": "mailbox_full"}`` before a
byte of its body is read, and stores nothing. Every other mailbox carries on.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import pytest
from starlette.testclient import TestClient

from reconcile.relay import push
from reconcile.relay.app import create_app
from reconcile.relay.settings import Settings
from reconcile.relay.store import day_of
from tests.relay.helpers import (
    DAY,
    NOON,
    SUBJECT,
    FakeClock,
    FakeSender,
    blob,
    body_receiver,
    call,
    mailbox_id,
    nudge_rows,
    push_endpoint,
    put,
    row_count,
    store_of,
    subscribe,
    wake_put,
)

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from starlette.types import ASGIApp

    from tests.relay.helpers import Message, Receive

CAP = 4 * 1024  # room for four 1 KiB blobs, or one 4 KiB blob
FULL = b'{"error":"mailbox_full"}'
LIVE = day_of(NOON) + 31  # the expiry day of a blob put today with ttl_days=30


def put_headers(size: int) -> list[tuple[bytes, bytes]]:
    """The headers of a raw blob PUT declaring ``size`` bytes."""
    return [
        (b"content-type", b"application/octet-stream"),
        (b"content-length", str(size).encode()),
    ]


@pytest.fixture
def capped_app(db_path: Path, clock: FakeClock) -> Iterator[ASGIApp]:
    """A relay whose mailboxes each hold at most ``CAP`` bytes."""
    relay = create_app(Settings(db_path=db_path, max_mailbox_bytes=CAP), clock)
    yield relay
    store_of(relay).close()


@pytest.fixture
def capped(capped_app: ASGIApp) -> Iterator[TestClient]:
    """A test client for the capped relay."""
    with TestClient(capped_app) as test_client:
        yield test_client


def fill(client: TestClient, mailbox: str) -> None:
    """Fill ``mailbox`` to exactly ``CAP`` with 1 KiB blobs, each stored."""
    for _ in range(CAP // 1024):
        assert put(client, mailbox, blob()).status_code == 201


def test_a_full_mailbox_refuses_the_put_and_stores_nothing(
    capped: TestClient, db_path: Path
) -> None:
    """The PUT that would pass the cap gets a constant 507 and leaves no row."""
    mailbox = mailbox_id()
    fill(capped, mailbox)
    before = row_count(db_path)

    response = put(capped, mailbox, blob())

    assert response.status_code == 507
    assert response.content == FULL
    assert row_count(db_path) == before


def test_a_full_mailbox_leaves_other_mailboxes_writable(
    capped: TestClient, db_path: Path
) -> None:
    """Filling one mailbox to its cap leaves PUTs to another at 201, to its own cap."""
    full, other = mailbox_id(), mailbox_id()
    fill(capped, full)

    fill(capped, other)

    assert put(capped, full, blob()).status_code == 507
    assert row_count(db_path) == 2 * CAP // 1024


@pytest.mark.parametrize(
    ("stored", "size", "status"),
    [
        ((), CAP, 201),  # one blob exactly the cap's size fits
        ((1024, 1024, 1024), 1024, 201),  # filling it to exactly the cap fits
        ((1024, 1024, 1024, 1024), 1024, 507),  # one byte past it doesn't
        ((1024,), 4096, 507),  # the incoming blob counts at its full size
        ((), 16384, 507),  # a blob bigger than the whole cap never fits
    ],
)
def test_a_put_fits_while_the_mailbox_stays_within_its_cap(
    capped: TestClient, stored: tuple[int, ...], size: int, status: int
) -> None:
    """A PUT fits exactly when the mailbox's bytes plus its own are at most the cap."""
    mailbox = mailbox_id()
    for earlier in stored:
        assert put(capped, mailbox, blob(earlier)).status_code == 201

    assert put(capped, mailbox, blob(size)).status_code == status


def test_a_full_mailbox_never_reads_the_body(
    capped_app: ASGIApp, db_path: Path
) -> None:
    """The cap is checked against the declared length, before the body is read."""
    mailbox = mailbox_id()
    for _ in range(CAP // 1024):
        store_of(capped_app).append(mailbox, blob(), received=0, expiry=LIVE)
    receive, given = body_receiver(blob())

    result = asyncio.run(
        call(
            capped_app,
            "PUT",
            f"/v1/mailbox/{mailbox}",
            receive=receive,
            headers=put_headers(1024),
        )
    )

    assert result.status == 507
    assert result.body == FULL
    assert given == []
    assert row_count(db_path) == CAP // 1024


def test_expired_blobs_no_longer_count(
    capped: TestClient, clock: FakeClock, db_path: Path
) -> None:
    """A blob stops counting on its expiry day, before the daily purge deletes it."""
    mailbox = mailbox_id()
    assert put(capped, mailbox, blob(CAP), ttl_days=1).status_code == 201  # today + 2

    clock.advance(DAY)
    still_live = put(capped, mailbox, blob())
    clock.advance(DAY)
    expired = put(capped, mailbox, blob())

    assert still_live.status_code == 507
    assert expired.status_code == 201
    assert row_count(db_path) == 2  # the expired row is still there, unpurged


def test_mailbox_full_never_names_the_mailbox(capped: TestClient) -> None:
    """The refusal is the same bytes for every mailbox, in its body and headers."""
    mailbox = mailbox_id()
    fill(capped, mailbox)

    response = put(capped, mailbox, blob())

    assert response.content == FULL
    assert all(mailbox not in value for value in response.headers.values())


def test_storage_full_is_checked_before_mailbox_full(
    capped: TestClient, capped_app: ASGIApp, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With the relay and the mailbox both full, the relay's cap answers."""
    mailbox = mailbox_id()
    fill(capped, mailbox)
    store = store_of(capped_app)
    monkeypatch.setattr(
        store, "size_bytes", lambda: Settings(store.path).max_db_bytes + 1
    )

    response = put(capped, mailbox, blob())

    assert response.status_code == 507
    assert response.json() == {"error": "storage_full"}


def test_uploads_in_flight_cant_carry_a_mailbox_past_its_cap(
    capped_app: ASGIApp, db_path: Path
) -> None:
    """Two uploads that each fit when they start can't both be stored.

    Both pass the check before their bodies; whichever lands second finds the
    mailbox full and is refused with nothing stored, its body read but dropped.
    """
    mailbox = mailbox_id()
    path = f"/v1/mailbox/{mailbox}"

    async def scenario() -> tuple[int, int, bytes]:
        """Start two 4 KiB uploads, then let them land one after the other."""
        started = [asyncio.Event(), asyncio.Event()]
        release = [asyncio.Event(), asyncio.Event()]

        def held(index: int) -> Receive:
            """A ``receive`` that holds the body back until it's released."""

            async def receive() -> Message:
                """Say the upload has started, wait, then hand over the body."""
                started[index].set()
                await release[index].wait()
                return {"type": "http.request", "body": blob(CAP), "more_body": False}

            return receive

        uploads = [
            asyncio.ensure_future(
                call(capped_app, "PUT", path, receive=held(i), headers=put_headers(CAP))
            )
            for i in range(2)
        ]
        for event in started:
            await event.wait()
        release[0].set()
        first = await uploads[0]
        release[1].set()
        second = await uploads[1]
        return first.status, second.status, second.body

    first, second, body = asyncio.run(scenario())

    assert (first, second, body) == (201, 507, FULL)
    assert row_count(db_path) == 1


def test_a_refused_put_schedules_no_wake(
    db_path: Path,
    vapid_key: Path,
    clock: FakeClock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``wake=1`` on a PUT the cap refuses leaves no nudge behind."""
    monkeypatch.setattr(push, "TICK_SECONDS", 3600)
    settings = Settings(
        db_path=db_path,
        max_mailbox_bytes=CAP,
        vapid_key=vapid_key,
        vapid_subject=SUBJECT,
    )
    relay = create_app(settings, clock, sender=FakeSender())
    mailbox = mailbox_id()
    try:
        with TestClient(relay) as client:
            assert subscribe(client, mailbox, push_endpoint()).status_code == 204
            fill(client, mailbox)
            response = wake_put(client, mailbox)
    finally:
        store_of(relay).close()

    assert response.status_code == 507
    assert nudge_rows(db_path) == []
