"""The relay's SQLite store: one table of blobs and one ``meta`` row.

Each row holds only the mailbox id, its seq, the opaque blob, the minute it
was received and the UTC day it expires. Adding a column needs an ADR.
"""

from __future__ import annotations

import secrets
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from types import TracebackType

SECONDS_PER_MINUTE = 60
SECONDS_PER_DAY = 86_400
INSTANCE_BYTES = 16

_SCHEMA = """
CREATE TABLE IF NOT EXISTS blobs (
    mailbox TEXT NOT NULL,
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    blob BLOB NOT NULL,
    received INTEGER NOT NULL,
    expiry INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blobs_by_mailbox ON blobs (mailbox, seq);
CREATE INDEX IF NOT EXISTS blobs_by_expiry ON blobs (expiry);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def minute_of(unix_seconds: float) -> int:
    """Return the unix minute, floor(seconds / 60): the unit of ``received``."""
    return int(unix_seconds // SECONDS_PER_MINUTE)


def day_of(unix_seconds: float) -> int:
    """Return the UTC day number, floor(seconds / 86,400): the unit of ``expiry``."""
    return int(unix_seconds // SECONDS_PER_DAY)


@dataclass(frozen=True)
class Record:
    """One stored blob, as a GET returns it."""

    seq: int
    received: int
    blob: bytes


class BlobStore:
    """Appends blobs to mailboxes and reads them back in seq order.

    The connection is opened with ``check_same_thread=False``: the relay runs
    one Uvicorn worker whose ``async`` handlers call SQLite synchronously, so
    calls never overlap, but the thread that opens the store (the factory, or
    a test) needn't be the one the event loop runs on.
    """

    def __init__(self, path: Path) -> None:
        """Open or create the database at ``path``, in WAL mode."""
        self.path = path
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.execute("PRAGMA secure_delete=ON")
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        self._db.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('instance', ?)",
            (secrets.token_urlsafe(INSTANCE_BYTES),),
        )
        (instance,) = self._db.execute(
            "SELECT value FROM meta WHERE key = 'instance'"
        ).fetchone()
        self.instance: str = instance

    def append(self, mailbox: str, blob: bytes, *, received: int, expiry: int) -> int:
        """Store ``blob`` in ``mailbox`` and return its new seq."""
        rows = self._db.execute(
            "INSERT INTO blobs (mailbox, blob, received, expiry)"
            " VALUES (?, ?, ?, ?) RETURNING seq",
            (mailbox, blob, received, expiry),
        ).fetchall()
        return int(rows[0][0])

    def read(self, mailbox: str, *, after: int, limit: int, today: int) -> list[Record]:
        """Return up to ``limit`` unexpired records with seq > ``after``, ascending."""
        rows = self._db.execute(
            "SELECT seq, received, blob FROM blobs"
            " WHERE mailbox = ? AND seq > ? AND expiry > ?"
            " ORDER BY seq LIMIT ?",
            (mailbox, after, today, limit),
        ).fetchall()
        return [Record(seq, received, blob) for seq, received, blob in rows]

    def delete_expired(self, today: int) -> int:
        """Delete every row whose expiry day has come; return how many."""
        return self._db.execute(
            "DELETE FROM blobs WHERE expiry <= ?", (today,)
        ).rowcount

    def checkpoint(self) -> None:
        """Copy the WAL into the main file and truncate the WAL to zero bytes."""
        self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()

    def size_bytes(self) -> int:
        """Return the size of the database file plus its WAL, in bytes."""
        return _size(self.path) + _size(Path(f"{self.path}-wal"))

    def close(self) -> None:
        """Close the connection. Closing twice is harmless."""
        self._db.close()

    def __enter__(self) -> BlobStore:
        """Use the store as a context manager that closes it."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the store."""
        self.close()


def _size(path: Path) -> int:
    """Return the size of ``path`` in bytes, or 0 if it doesn't exist."""
    try:
        return path.stat().st_size
    except FileNotFoundError:
        return 0
