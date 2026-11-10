"""The relay backup (#97; ADR-0043 §3, ADR-0072 items 13 and 14).

``PUT /v1/backup/{id}`` keeps one padded blob under a 43-character id, in
one of five sizes, replacing any earlier one. ``GET`` returns it, or 404.
The row holds the id, the blob and a whole UTC expiry day, 181 days after
the day of the last write, and nothing else: no receipt time, no counter.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from typing import TYPE_CHECKING

import pytest
from starlette.testclient import TestClient

from reconcile.relay.app import create_app
from reconcile.relay.purge import purge
from reconcile.relay.settings import Settings
from tests.relay.helpers import (
    BACKUP_SIZES,
    DAY,
    MAX_BACKUP,
    NOON,
    FakeClock,
    backup_rows,
    blob,
    body_receiver,
    call,
    mailbox_id,
    put_backup,
    row_count,
    sqlite_files,
    store_of,
)

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from starlette.types import ASGIApp

TODAY = int(NOON) // DAY  # 2026-11-09
MIDNIGHT = TODAY * DAY
VALID_ID = "B" * 43
NOT_FOUND = {"error": "not_found"}


def backup_headers(length: bytes) -> list[tuple[bytes, bytes]]:
    """The headers of a raw backup PUT declaring ``length``."""
    return [
        (b"content-type", b"application/octet-stream"),
        (b"content-length", length),
    ]


@pytest.fixture
def unchanged(db_path: Path, client: TestClient) -> Iterator[None]:
    """Assert, after the test, that no backup row was added, changed or lost."""
    put_backup(client, mailbox_id(), blob(65536))  # so "unchanged" isn't trivially []
    before = backup_rows(db_path)
    yield
    assert backup_rows(db_path) == before


# --- Storing and reading ----------------------------------------------------


@pytest.mark.parametrize("size", BACKUP_SIZES)
def test_a_backup_put_then_get_returns_the_same_bytes(
    client: TestClient, size: int
) -> None:
    """Each of the five sizes is stored and comes back byte for byte."""
    backup = mailbox_id()
    data = bytes(range(256)) * (size // 256)

    stored = put_backup(client, backup, data)
    fetched = client.get(f"/v1/backup/{backup}")

    assert (stored.status_code, stored.content) == (204, b"")
    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == "application/octet-stream"
    assert fetched.content == data


def test_a_second_put_replaces_the_first(client: TestClient, db_path: Path) -> None:
    """One row per id: a later PUT, even of another size, replaces the blob."""
    backup = mailbox_id()
    put_backup(client, backup, blob(262144, 0x01))

    assert put_backup(client, backup, blob(65536, 0x02)).status_code == 204

    assert client.get(f"/v1/backup/{backup}").content == blob(65536, 0x02)
    assert backup_rows(db_path) == [(backup, 65536, TODAY + 181)]


def test_backups_are_kept_apart_by_id(client: TestClient, db_path: Path) -> None:
    """Two ids hold two blobs, and neither reads the other's."""
    first, second = sorted([mailbox_id(), mailbox_id()])
    put_backup(client, first, blob(65536, 0x01))
    put_backup(client, second, blob(65536, 0x02))

    assert client.get(f"/v1/backup/{first}").content == blob(65536, 0x01)
    assert client.get(f"/v1/backup/{second}").content == blob(65536, 0x02)
    assert [row[0] for row in backup_rows(db_path)] == [first, second]


def test_an_unknown_backup_is_a_constant_404(client: TestClient) -> None:
    """A GET of an id nobody stored says only ``not_found``."""
    response = client.get(f"/v1/backup/{mailbox_id()}")

    assert response.status_code == 404
    assert response.json() == NOT_FOUND


def test_a_backup_is_no_mailbox(client: TestClient, db_path: Path) -> None:
    """A backup lives in its own table: its id reads as an empty mailbox."""
    backup = mailbox_id()
    put_backup(client, backup, blob(65536))

    page = client.get(f"/v1/mailbox/{backup}").json()

    assert page["records"] == []
    assert row_count(db_path) == 0


# --- Refusals ---------------------------------------------------------------


@pytest.mark.parametrize(
    "size", [0, 1024, 16384, 65535, 65537, 131072, 262143, 1048577, 16777215]
)
@pytest.mark.usefixtures("unchanged")
def test_a_backup_outside_the_five_sizes_is_refused(
    client: TestClient, size: int
) -> None:
    """Any other size gets 400 invalid_size, a mailbox blob's sizes included."""
    response = put_backup(client, mailbox_id(), blob(size))

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_size"}


@pytest.mark.parametrize("length", [b"16777217", b"33554432", b"9" * 25])
def test_a_content_length_over_16_mib_is_refused_unread(
    app: ASGIApp, db_path: Path, length: bytes
) -> None:
    """The body of an oversized backup PUT is never read, and nothing is stored."""
    receive, given = body_receiver(blob(65536))

    result = asyncio.run(
        call(
            app,
            "PUT",
            f"/v1/backup/{VALID_ID}",
            receive=receive,
            headers=backup_headers(length),
        )
    )

    assert (result.status, result.body) == (413, b'{"error":"too_large"}')
    assert given == []
    assert backup_rows(db_path) == []


@pytest.mark.parametrize("length", [b"65535", b"1000000", b"16777215"])
def test_a_declared_size_outside_the_five_is_refused_unread(
    app: ASGIApp, db_path: Path, length: bytes
) -> None:
    """A declared length that isn't a backup size is refused before the body."""
    receive, given = body_receiver(blob(1024))

    result = asyncio.run(
        call(
            app,
            "PUT",
            f"/v1/backup/{VALID_ID}",
            receive=receive,
            headers=backup_headers(length),
        )
    )

    assert (result.status, result.body) == (400, b'{"error":"invalid_size"}')
    assert given == []
    assert backup_rows(db_path) == []


@pytest.mark.parametrize(
    ("headers", "status", "body"),
    [
        ([(b"content-type", b"application/octet-stream")], 411, "length_required"),
        (backup_headers(b"6e4"), 400, "invalid_length"),
        (
            [(b"content-type", b"text/plain"), (b"content-length", b"65536")],
            415,
            "unsupported_media_type",
        ),
    ],
)
def test_a_malformed_upload_is_refused_unread(
    app: ASGIApp,
    db_path: Path,
    headers: list[tuple[bytes, bytes]],
    status: int,
    body: str,
) -> None:
    """No length, a length that isn't digits, or another media type: no read."""
    receive, given = body_receiver(blob(65536))

    result = asyncio.run(
        call(app, "PUT", f"/v1/backup/{VALID_ID}", receive=receive, headers=headers)
    )

    assert (result.status, result.body) == (status, f'{{"error":"{body}"}}'.encode())
    assert given == []
    assert backup_rows(db_path) == []


@pytest.mark.parametrize("chunks", [(blob(65535),), (blob(65536), blob(1))])
def test_a_body_that_differs_from_its_length_is_refused(
    app: ASGIApp, db_path: Path, chunks: tuple[bytes, ...]
) -> None:
    """A body shorter or longer than declared stores nothing."""
    receive, _ = body_receiver(*chunks)

    result = asyncio.run(
        call(
            app,
            "PUT",
            f"/v1/backup/{VALID_ID}",
            receive=receive,
            headers=backup_headers(b"65536"),
        )
    )

    assert (result.status, result.body) == (400, b'{"error":"invalid_size"}')
    assert backup_rows(db_path) == []


@pytest.mark.parametrize(
    "backup",
    [
        "B" * 42,
        "B" * 44,
        "B" * 42 + "+",
        "B" * 42 + "=",
        "B" * 42 + "é",
        VALID_ID + "%0A",
    ],
)
@pytest.mark.usefixtures("unchanged")
def test_a_malformed_backup_id_is_refused(client: TestClient, backup: str) -> None:
    """Only 43 base64url characters name a backup, for PUT and GET alike."""
    responses = [
        put_backup(client, backup, blob(65536)),
        client.get(f"/v1/backup/{backup}"),
    ]

    for response in responses:
        assert response.status_code == 400
        assert response.json() == {"error": "invalid_backup"}


@pytest.mark.usefixtures("unchanged")
def test_a_slash_in_the_backup_id_matches_no_route(client: TestClient) -> None:
    """A ``/`` splits the path, so no backup route matches at all."""
    response = put_backup(client, "B" * 21 + "/" + "B" * 21, blob(65536))

    assert response.status_code == 404
    assert response.json() == NOT_FOUND


@pytest.mark.parametrize("method", ["DELETE", "POST", "PATCH"])
@pytest.mark.usefixtures("unchanged")
def test_a_backup_has_no_other_method(client: TestClient, method: str) -> None:
    """There is no DELETE in the MVP: a backup goes when it expires."""
    response = client.request(method, f"/v1/backup/{VALID_ID}")

    assert response.status_code == 405
    assert response.json() == {"error": "method_not_allowed"}


@pytest.fixture
def full_app(db_path: Path, clock: FakeClock) -> Iterator[ASGIApp]:
    """A relay whose storage cap is already passed: one byte."""
    relay = create_app(Settings(db_path=db_path, max_db_bytes=1), clock)
    yield relay
    store_of(relay).close()


def test_a_full_relay_refuses_a_backup_unread(full_app: ASGIApp, db_path: Path) -> None:
    """Past the storage cap a backup PUT gets 507 storage_full before its body."""
    receive, given = body_receiver(blob(65536))

    result = asyncio.run(
        call(
            full_app,
            "PUT",
            f"/v1/backup/{VALID_ID}",
            receive=receive,
            headers=backup_headers(b"65536"),
        )
    )

    assert (result.status, result.body) == (507, b'{"error":"storage_full"}')
    assert given == []
    assert backup_rows(db_path) == []


def test_the_mailbox_cap_doesnt_count_backups(db_path: Path, clock: FakeClock) -> None:
    """A mailbox's byte cap (#141) counts its blobs, never a backup's bytes."""
    capped = create_app(Settings(db_path=db_path, max_mailbox_bytes=1024), clock)
    shared = mailbox_id()
    try:
        with TestClient(capped) as client:
            assert put_backup(client, shared, blob(MAX_BACKUP)).status_code == 204
            mailbox_put = client.put(
                f"/v1/mailbox/{shared}",
                content=blob(1024),
                headers={"content-type": "application/octet-stream"},
            )
    finally:
        store_of(capped).close()

    assert mailbox_put.status_code == 201


# --- Expiry and purge -------------------------------------------------------


@pytest.mark.parametrize("seconds_into_day", [0, 1, 12 * 3600, DAY - 1])
def test_expiry_is_a_whole_utc_day_181_days_out(
    client: TestClient, db_path: Path, clock: FakeClock, seconds_into_day: int
) -> None:
    """Any moment of a UTC day stores the same expiry: the day number plus 181."""
    clock.now = MIDNIGHT + seconds_into_day
    backup = mailbox_id()

    put_backup(client, backup, blob(65536))

    ((_, _, expiry),) = backup_rows(db_path)
    assert expiry == TODAY + 181
    assert dt.datetime.fromtimestamp(expiry * DAY, dt.UTC) == dt.datetime(
        2027, 5, 9, tzinfo=dt.UTC
    )


def test_a_refresh_moves_the_expiry_out(
    client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """A later PUT keeps the backup 180 days after it, not after the first."""
    backup = mailbox_id()
    put_backup(client, backup, blob(65536))
    clock.advance(10 * DAY)

    put_backup(client, backup, blob(65536, 0x42))

    assert backup_rows(db_path) == [(backup, 65536, TODAY + 10 + 181)]


def test_a_get_doesnt_refresh_a_backup(
    client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """Reading a backup leaves its expiry alone: only a write refreshes it."""
    backup = mailbox_id()
    put_backup(client, backup, blob(65536))
    clock.advance(100 * DAY)

    assert client.get(f"/v1/backup/{backup}").status_code == 200

    assert backup_rows(db_path) == [(backup, 65536, TODAY + 181)]


def test_a_get_skips_a_backup_from_its_expiry_day(
    client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """A backup is unreadable from the start of its expiry day, purged or not."""
    backup = mailbox_id()
    clock.now = MIDNIGHT + DAY - 1  # 23:59:59, the latest moment of the write's day
    put_backup(client, backup, blob(65536))

    clock.now = MIDNIGHT + 181 * DAY - 1  # one second before the expiry day
    still_there = client.get(f"/v1/backup/{backup}")
    clock.now = MIDNIGHT + 181 * DAY  # the expiry day begins
    gone = client.get(f"/v1/backup/{backup}")

    assert still_there.status_code == 200
    assert (gone.status_code, gone.json()) == (404, NOT_FOUND)
    assert len(backup_rows(db_path)) == 1


def test_the_purge_removes_exactly_the_expired_backups(
    client: TestClient, app: ASGIApp, db_path: Path, clock: FakeClock
) -> None:
    """The purge deletes backups whose expiry day has come, and nothing else."""
    old, fresh = mailbox_id(), mailbox_id()
    put_backup(client, old, blob(65536))
    clock.advance(DAY)
    put_backup(client, fresh, blob(65536))

    deleted_early = purge(store_of(app), MIDNIGHT + 181 * DAY - 1)
    deleted = purge(store_of(app), MIDNIGHT + 181 * DAY)

    assert deleted_early == 0
    assert deleted == 1
    assert backup_rows(db_path) == [(fresh, 65536, TODAY + 182)]


def test_replaced_and_purged_backups_leave_no_trace(
    client: TestClient, app: ASGIApp, db_path: Path, clock: FakeClock
) -> None:
    """secure_delete zeroes a replaced blob and a purged one once checkpointed."""
    replaced = b"\x5a\xa5" * 32768  # 64 KiB patterns nothing else contains
    purged = b"\x3c\xc3" * 32768
    backup, other = mailbox_id(), mailbox_id()
    put_backup(client, backup, replaced)
    put_backup(client, other, purged)
    store = store_of(app)
    store.checkpoint()
    assert replaced[:1024] in sqlite_files(db_path)["relay.db"]

    put_backup(client, backup, blob(65536, 0x00))
    clock.advance(DAY)
    put_backup(client, backup, blob(65536, 0x00))  # keeps `backup` past `other`
    purge(store, MIDNIGHT + 181 * DAY)

    files = sqlite_files(db_path)
    assert files["relay.db-wal"] == b""
    for name, data in files.items():
        assert replaced[:64] not in data, name
        assert purged[:64] not in data, name
    assert [row[0] for row in backup_rows(db_path)] == [backup]
