"""The database holds only what the issue allows: no column without an ADR."""

from __future__ import annotations

import base64
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from reconcile.relay.store import BlobStore

if TYPE_CHECKING:
    from collections.abc import Iterator

BLOB_COLUMNS = [
    ("mailbox", "TEXT"),
    ("seq", "INTEGER"),
    ("blob", "BLOB"),
    ("received", "INTEGER"),
    ("expiry", "INTEGER"),
]


@pytest.fixture
def store(db_path: Path) -> Iterator[BlobStore]:
    """A freshly created store."""
    created = BlobStore(db_path)
    yield created
    created.close()


@pytest.fixture
def db(store: BlobStore) -> Iterator[sqlite3.Connection]:
    """A second connection for inspecting the store's file."""
    with closing(sqlite3.connect(store.path)) as connection:
        yield connection


def test_blobs_has_exactly_the_five_columns(db: sqlite3.Connection) -> None:
    """Adding a column to ``blobs`` fails here until an ADR allows it."""
    columns = [(row[1], row[2]) for row in db.execute("PRAGMA table_info(blobs)")]

    assert columns == BLOB_COLUMNS


def test_seq_is_an_autoincrement_primary_key(db: sqlite3.Connection) -> None:
    """``seq`` is the rowid, and AUTOINCREMENT stops it from ever being reused."""
    (sql,) = db.execute("SELECT sql FROM sqlite_master WHERE name = 'blobs'").fetchone()
    primary = [row[1] for row in db.execute("PRAGMA table_info(blobs)") if row[5]]

    assert primary == ["seq"]
    assert "INTEGER PRIMARY KEY AUTOINCREMENT" in " ".join(sql.split())


def test_the_only_tables_are_blobs_meta_and_sqlite_sequence(
    db: sqlite3.Connection,
) -> None:
    """There is no other table to grow a list of people in."""
    tables = {
        name
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }

    assert tables == {"blobs", "meta", "sqlite_sequence"}


def test_meta_holds_only_the_instance(db: sqlite3.Connection) -> None:
    """``meta`` is a key-value table with one row, ``instance``."""
    columns = [row[1] for row in db.execute("PRAGMA table_info(meta)")]
    keys = [key for (key,) in db.execute("SELECT key FROM meta")]

    assert columns == ["key", "value"]
    assert keys == ["instance"]


def test_blobs_is_indexed_by_mailbox_then_seq_and_by_expiry(
    db: sqlite3.Connection,
) -> None:
    """Reads walk (mailbox, seq); the purge walks expiry."""
    indexed = {
        tuple(row[2] for row in db.execute(f"PRAGMA index_info('{name}')"))
        for (_, name, *_) in db.execute("PRAGMA index_list(blobs)")
    }

    assert {("mailbox", "seq"), ("expiry",)} <= indexed


def test_the_database_is_in_wal_mode(db: sqlite3.Connection) -> None:
    """WAL mode persists in the file, so any connection reports it."""
    (mode,) = db.execute("PRAGMA journal_mode").fetchone()

    assert mode == "wal"


def test_instance_is_sixteen_random_bytes_in_base64url(store: BlobStore) -> None:
    """The instance id is 16 bytes as unpadded base64url: 22 characters."""
    raw = base64.urlsafe_b64decode(store.instance + "==")

    assert len(store.instance) == 22
    assert len(raw) == 16
    assert base64.urlsafe_b64encode(raw).rstrip(b"=").decode() == store.instance


def test_a_fresh_database_gets_a_new_instance(tmp_path: Path) -> None:
    """Each new database has its own instance; reopening one keeps it."""
    first = BlobStore(tmp_path / "first.db")
    second = BlobStore(tmp_path / "second.db")
    first_instance = first.instance
    first.close()
    second.close()

    reopened = BlobStore(tmp_path / "first.db")
    try:
        assert reopened.instance == first_instance
    finally:
        reopened.close()
    assert second.instance != first_instance


def test_size_counts_the_database_and_its_wal(store: BlobStore) -> None:
    """The storage cap counts the main file plus everything still in the WAL."""
    for seq in range(8):
        store.append(f"{'A' * 42}{seq % 2}", b"\x01" * 65536, received=1, expiry=2)
    wal = Path(f"{store.path}-wal")

    assert wal.stat().st_size > 0
    assert store.size_bytes() == store.path.stat().st_size + wal.stat().st_size


def test_size_without_a_wal_is_just_the_database(store: BlobStore) -> None:
    """Closing the last connection folds the WAL away; then only the file counts."""
    store.append("A" * 43, b"\x01" * 65536, received=1, expiry=2)
    store.close()

    assert not Path(f"{store.path}-wal").exists()
    assert store.size_bytes() == store.path.stat().st_size
