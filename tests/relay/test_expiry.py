"""Expiry by the UTC day: stored rounded, skipped when due, purged for good."""

from __future__ import annotations

import datetime as dt
import os
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from reconcile.relay import purge as purge_module
from reconcile.relay.purge import purge
from reconcile.relay.store import BlobStore
from tests.relay.helpers import (
    DAY,
    NOON,
    FakeClock,
    blob,
    mailbox_id,
    put,
    row_count,
    sqlite_files,
    store_of,
    stored_rows,
)

if TYPE_CHECKING:
    from starlette.testclient import TestClient
    from starlette.types import ASGIApp

TODAY = int(NOON) // DAY  # 2026-11-09
MIDNIGHT = TODAY * DAY
ROOT = Path(__file__).resolve().parents[2]


def _expiry_after_put(client: TestClient, db_path: Path, ttl_days: int | None) -> int:
    """PUT one blob and return the expiry day stored for it."""
    put(client, mailbox_id(), blob(), ttl_days=ttl_days)
    return int(stored_rows(db_path)[-1][3])


@pytest.mark.parametrize("seconds_into_day", [0, 1, 12 * 3600, DAY - 1])
def test_stored_expiry_is_a_whole_utc_day(
    client: TestClient, db_path: Path, clock: FakeClock, seconds_into_day: int
) -> None:
    """Any moment of a UTC day stores the same expiry: a day number, no time."""
    clock.now = MIDNIGHT + seconds_into_day

    expiry = _expiry_after_put(client, db_path, ttl_days=2)

    assert expiry == TODAY + 3
    expires_at = dt.datetime.fromtimestamp(expiry * DAY, dt.UTC)
    assert expires_at == dt.datetime(2026, 11, 12, tzinfo=dt.UTC)


@pytest.mark.parametrize(("ttl", "expiry"), [(1, TODAY + 2), (30, TODAY + 31)])
def test_expiry_is_receipt_day_plus_ttl_plus_one(
    client: TestClient, db_path: Path, ttl: int, expiry: int
) -> None:
    """A blob lives at least ``ttl_days`` full days, rounded up to midnight UTC."""
    assert _expiry_after_put(client, db_path, ttl_days=ttl) == expiry


def test_ttl_defaults_to_thirty_days(client: TestClient, db_path: Path) -> None:
    """Without ``ttl_days`` a blob is kept the full 30 days (ADR-0057)."""
    assert _expiry_after_put(client, db_path, ttl_days=None) == TODAY + 31


def test_received_is_the_unix_minute(
    client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """``received`` is floor(unix seconds / 60), not seconds or milliseconds."""
    clock.now = NOON + 59.9
    put(client, mailbox_id(), blob())

    ((_, _, received, _),) = stored_rows(db_path)

    assert received == int(NOON) // 60


def test_get_skips_expired_rows_the_purge_hasnt_reached(
    client: TestClient, db_path: Path, clock: FakeClock
) -> None:
    """A row is unreadable from the start of its expiry day, purged or not."""
    mailbox = mailbox_id()
    clock.now = MIDNIGHT + DAY - 1  # 23:59:59, the latest moment of receipt day
    put(client, mailbox, blob(), ttl_days=1)

    clock.now = MIDNIGHT + 2 * DAY - 1  # one second before the expiry day
    still_there = client.get(f"/v1/mailbox/{mailbox}").json()["records"]
    clock.now = MIDNIGHT + 2 * DAY  # the expiry day begins
    gone = client.get(f"/v1/mailbox/{mailbox}").json()["records"]

    assert len(still_there) == 1
    assert gone == []
    assert row_count(db_path) == 1


def test_purge_removes_exactly_the_expired_rows(
    client: TestClient, app: ASGIApp, db_path: Path, clock: FakeClock
) -> None:
    """The purge deletes rows whose expiry day has come, and nothing else."""
    for ttl in (1, 2, 3):
        put(client, mailbox_id(), blob(), ttl_days=ttl)

    deleted_early = purge(store_of(app), MIDNIGHT + 2 * DAY - 1)
    deleted = purge(store_of(app), MIDNIGHT + 3 * DAY)

    assert deleted_early == 0
    assert deleted == 2
    assert [row[3] for row in stored_rows(db_path)] == [TODAY + 4]


def test_purge_leaves_no_trace_of_deleted_blobs(
    client: TestClient, app: ASGIApp, db_path: Path, clock: FakeClock
) -> None:
    """secure_delete zeroes purged blobs, and the checkpoint empties the WAL."""
    marker = b"\x5a\xa5" * 32768  # a 64 KiB pattern nothing else contains
    put(client, mailbox_id(), marker, ttl_days=1)
    store = store_of(app)
    store.checkpoint()  # move the blob from the WAL into the main file
    assert marker[:1024] in sqlite_files(db_path)["relay.db"]

    purge(store, MIDNIGHT + 2 * DAY)

    files = sqlite_files(db_path)
    assert files["relay.db-wal"] == b""
    for name, data in files.items():
        assert marker[:64] not in data, name


def test_purge_main_reads_the_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``main()`` purges the database named by RECONCILE_RELAY_DB, by today's date."""
    db_path = tmp_path / "relay.db"
    store = BlobStore(db_path)
    long_ago = int(dt.datetime(2020, 1, 1, tzinfo=dt.UTC).timestamp()) // DAY
    store.append(mailbox_id(), blob(), received=1, expiry=long_ago)
    store.append(mailbox_id(), blob(), received=1, expiry=10**9)
    store.close()
    monkeypatch.setenv("RECONCILE_RELAY_DB", str(db_path))

    assert purge_module.main() == 0

    assert [row[3] for row in stored_rows(db_path)] == [10**9]


def test_python_dash_m_purge_runs_quietly(tmp_path: Path) -> None:
    """``python -m reconcile.relay.purge`` purges and prints nothing."""
    db_path = tmp_path / "relay.db"
    store = BlobStore(db_path)
    store.append(mailbox_id(), blob(), received=1, expiry=1)
    store.close()

    result = subprocess.run(
        [sys.executable, "-m", "reconcile.relay.purge"],
        cwd=ROOT,
        env={**os.environ, "RECONCILE_RELAY_DB": str(db_path)},
        capture_output=True,
        check=False,
    )

    assert (result.returncode, result.stdout, result.stderr) == (0, b"", b"")
    assert row_count(db_path) == 0
