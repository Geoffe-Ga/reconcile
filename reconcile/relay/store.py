"""The relay's SQLite store: blobs, one ``meta`` row, push's two tables, backups.

Each blob row holds only the mailbox id, its seq, the opaque blob, the minute
it was received and the UTC day it expires. Push (#89, ADR-0012) adds what
ADR-0019 allows it, endpoints and wake minutes, and nothing else:

- ``push_subs``: a mailbox's push endpoints, each with its expiry day.
- ``nudges``: the minutes a mailbox is due a wake. The key collapses wakes
  in one minute into one row.

Neither holds a push key (no payload is sent), a timestamp or a counter.

The relay backup (#97, ADR-0043 §3) adds ``backups``: one padded blob per
43-character id, with the UTC day it expires and nothing else. A write
replaces the row, so no earlier copy stays, and ``WITHOUT ROWID`` leaves no
counter that would order backups by when each first arrived. Adding a column
needs an ADR.

The public shelf (#484, docs/spec/listed-doors.md §4.2, ADR-0081) adds
``shelf``: the first rows whose bodies the relay can read. Each holds a
record's seq, the address it was PUT under, its kind, the id it names or
``""``, its signed bytes, its receipt minute, its expiry day and the minute
it is held until (0 for a record that isn't held). Nothing else, and no
index on an address, so nothing is quicker to look up by group.

Held mode (#488, §4.2): an address's first listing, and every record under it
while it waits, is held until ``HELD_UNTIL_RELEASED``, a minute no clock
reaches, and a ``release`` notice clears that hold. A notice's ``ref`` is the
address it names, so a listing's renewal can carry its release's expiry with
it: a release lasts as long as the listing it released.

The steward's later notices (#489, §6.1): a ``hold`` sets ``held_until`` to
the minute it lapses, on an address's records or one entry, never
shortening a longer wait; an ``uphold`` deletes an entry and a ``suspend``
an address's records. Each notice is filed under a ``ref`` naming what it
acts on, so the relay finds a standing one without reading a body. An
``unsuspend`` (#490) deletes nothing: the newer of an address's suspend and
unsuspend, by seq, says whether it is suspended.

Each mailbox has a byte cap (#141). ``blobs_by_mailbox_size`` indexes each
blob's length beside its mailbox and expiry, so summing a mailbox's unexpired
bytes reads that index alone and never a blob.
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
MINUTES_PER_DAY = SECONDS_PER_DAY // SECONDS_PER_MINUTE
INSTANCE_BYTES = 16
# The minute a held record waits until: SQLite's largest INTEGER, which no
# clock reaches, so only a release notice clears it (#488).
HELD_UNTIL_RELEASED = 2**63 - 1

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
CREATE INDEX IF NOT EXISTS blobs_by_mailbox_size
    ON blobs (mailbox, expiry, length(blob));
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
    mailbox TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    PRIMARY KEY (mailbox, endpoint)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS nudges (
    mailbox TEXT NOT NULL,
    due INTEGER NOT NULL,
    PRIMARY KEY (mailbox, due)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS backups (
    id TEXT NOT NULL PRIMARY KEY,
    blob BLOB NOT NULL,
    expiry INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS backups_by_expiry ON backups (expiry);
CREATE TABLE IF NOT EXISTS shelf (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    body BLOB NOT NULL,
    received INTEGER NOT NULL,
    expiry INTEGER NOT NULL,
    held_until INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shelf_by_expiry_size ON shelf (expiry, length(body));
"""

# A mailbox's unexpired bytes. SQLite reads each length from
# blobs_by_mailbox_size and never seeks the row that holds the blob.
MAILBOX_BYTES_SQL = (
    "SELECT coalesce(sum(length(blob)), 0) FROM blobs WHERE mailbox = ? AND expiry > ?"
)


# The shelf's unexpired bytes, read from shelf_by_expiry_size alone.
SHELF_BYTES_SQL = "SELECT coalesce(sum(length(body)), 0) FROM shelf WHERE expiry > ?"


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


@dataclass(frozen=True)
class ShelfRow:
    """One shelf record, as a GET returns it."""

    seq: int
    received: int
    address: str
    body: bytes


@dataclass(frozen=True)
class ShelfWhen:
    """When a shelf record arrived, when it expires, and when it is held until."""

    received: int
    expiry: int
    held_until: int = 0


@dataclass(frozen=True)
class EntryCounts:
    """An address's live entries, and the entries that arrived today (#431)."""

    live: int
    today: int


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

    def mailbox_bytes(self, mailbox: str, *, today: int) -> int:
        """Return the bytes of ``mailbox``'s unexpired blobs, as a GET counts them.

        A blob stops counting on its expiry day, before the purge deletes it.
        """
        (used,) = self._db.execute(MAILBOX_BYTES_SQL, (mailbox, today)).fetchone()
        return int(used)

    def put_backup(self, backup: str, blob: bytes, *, expiry: int) -> None:
        """Store ``blob`` as the backup ``backup``, replacing any earlier one."""
        self._db.execute(
            "INSERT INTO backups (id, blob, expiry) VALUES (?, ?, ?)"
            " ON CONFLICT (id) DO UPDATE SET blob = excluded.blob,"
            " expiry = excluded.expiry",
            (backup, blob, expiry),
        )

    def get_backup(self, backup: str, *, today: int) -> bytes | None:
        """Return the backup ``backup``, or ``None`` once its expiry day has come."""
        row = self._db.execute(
            "SELECT blob FROM backups WHERE id = ? AND expiry > ?", (backup, today)
        ).fetchone()
        return None if row is None else bytes(row[0])

    def add_shelf(
        self, address: str, kind: str, ref: str, body: bytes, when: ShelfWhen
    ) -> int:
        """Store one shelf record and return its new seq."""
        rows = self._db.execute(
            "INSERT INTO shelf"
            " (address, kind, ref, body, received, expiry, held_until)"
            " VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
            (address, kind, ref, body, when.received, when.expiry, when.held_until),
        ).fetchall()
        return int(rows[0][0])

    def listing_body(self, address: str) -> bytes | None:
        """The signed bytes of ``address``'s listing, expired or not, or ``None``."""
        row = self._db.execute(
            "SELECT body FROM shelf WHERE address = ? AND kind = 'listing'",
            (address,),
        ).fetchone()
        return None if row is None else bytes(row[0])

    def put_listing(self, address: str, body: bytes, when: ShelfWhen) -> int:
        """Store ``address``'s listing in place of its earlier one; return its seq.

        An address has one listing row. A later copy takes the row's body,
        receipt and expiry and keeps its seq, so the listing stays where it
        was first listed in the shelf's order, and its hold stays as it was:
        ``when.held_until`` applies only to a first listing. Any release
        notice naming ``address`` is kept at least as long as the listing.
        """
        self._db.execute(
            "UPDATE shelf SET expiry = max(expiry, ?)"
            " WHERE kind = 'notice' AND ref = ?",
            (when.expiry, address),
        )
        rows = self._db.execute(
            "UPDATE shelf SET body = ?, received = ?, expiry = ?"
            " WHERE address = ? AND kind = 'listing' RETURNING seq",
            (body, when.received, when.expiry, address),
        ).fetchall()
        if rows:
            return int(rows[0][0])
        return self.add_shelf(address, "listing", "", body, when)

    def listing_held_until(self, address: str) -> int:
        """The minute ``address``'s listing is held until, or 0 with none (#489)."""
        row = self._db.execute(
            "SELECT held_until FROM shelf WHERE address = ? AND kind = 'listing'",
            (address,),
        ).fetchone()
        return 0 if row is None else int(row[0])

    def release(self, address: str, *, held_until: int = 0) -> int:
        """Clear the wait for a release under ``address``; return how many records.

        Each record waiting for a release is held until ``held_until`` instead:
        0, or the minute a hold that still stands lapses (#489).
        """
        return self._db.execute(
            "UPDATE shelf SET held_until = ? WHERE address = ? AND held_until = ?",
            (held_until, address, HELD_UNTIL_RELEASED),
        ).rowcount

    def hold(self, address: str, entry: str, *, until: int) -> int:
        """Hold ``address``'s records, or only its entry ``entry``, until ``until``.

        A record already held longer keeps its own minute. Returns how many.
        """
        if entry:
            return self._db.execute(
                "UPDATE shelf SET held_until = max(held_until, ?)"
                " WHERE address = ? AND kind = 'entry' AND ref = ?",
                (until, address, entry),
            ).rowcount
        return self._db.execute(
            "UPDATE shelf SET held_until = max(held_until, ?) WHERE address = ?",
            (until, address),
        ).rowcount

    def latest_notice(self, ref: str, *, today: int) -> int | None:
        """The receipt minute of the newest live notice under ``ref``, or ``None``."""
        (received,) = self._db.execute(
            "SELECT max(received) FROM shelf"
            " WHERE kind = 'notice' AND ref = ? AND expiry > ?",
            (ref, today),
        ).fetchone()
        return None if received is None else int(received)

    def newest_notice_seq(self, ref: str, *, today: int) -> int:
        """The seq of the newest live notice under ``ref``, or 0 with none (#490)."""
        (seq,) = self._db.execute(
            "SELECT coalesce(max(seq), 0) FROM shelf"
            " WHERE kind = 'notice' AND ref = ? AND expiry > ?",
            (ref, today),
        ).fetchone()
        return int(seq)

    def entry_expiry(self, address: str, entry: str, *, today: int) -> int | None:
        """The expiry day of ``address``'s live entry ``entry``, or ``None``."""
        row = self._db.execute(
            "SELECT expiry FROM shelf"
            " WHERE address = ? AND kind = 'entry' AND ref = ? AND expiry > ?",
            (address, entry, today),
        ).fetchone()
        return None if row is None else int(row[0])

    def drop_entry(self, address: str, entry: str) -> int:
        """Delete ``address``'s entry ``entry`` and any withdraw of it; how many."""
        return self._db.execute(
            "DELETE FROM shelf WHERE address = ? AND kind IN ('entry', 'withdraw')"
            " AND ref = ?",
            (address, entry),
        ).rowcount

    def drop_address(self, address: str) -> int:
        """Delete every record under ``address``; return how many (#489)."""
        return self._db.execute(
            "DELETE FROM shelf WHERE address = ?", (address,)
        ).rowcount

    def drop_entries(self, address: str) -> int:
        """Delete every record under ``address`` but its listing; return how many."""
        return self._db.execute(
            "DELETE FROM shelf WHERE address = ? AND kind != 'listing'", (address,)
        ).rowcount

    def unexpired_listing(self, address: str, *, today: int) -> bytes | None:
        """``address``'s listing's signed bytes until it expires, else ``None``."""
        row = self._db.execute(
            "SELECT body FROM shelf"
            " WHERE address = ? AND kind = 'listing' AND expiry > ?",
            (address, today),
        ).fetchone()
        return None if row is None else bytes(row[0])

    def shelf_seq(self, address: str, kind: str, ref: str, *, today: int) -> int | None:
        """The seq of ``address``'s live ``kind`` record naming ``ref``, or ``None``."""
        row = self._db.execute(
            "SELECT seq FROM shelf"
            " WHERE address = ? AND kind = ? AND ref = ? AND expiry > ?"
            " ORDER BY seq LIMIT 1",
            (address, kind, ref, today),
        ).fetchone()
        return None if row is None else int(row[0])

    def entry_counts(self, address: str, *, today: int) -> EntryCounts:
        """How many of ``address``'s entries are live, and how many arrived today.

        An entry is live until it expires or its address withdraws it. One
        that arrived today counts toward today's, withdrawn or not.
        """
        live, new = self._db.execute(
            "SELECT"
            " coalesce(sum(NOT EXISTS (SELECT 1 FROM shelf w"
            "  WHERE w.address = e.address AND w.kind = 'withdraw'"
            "  AND w.ref = e.ref AND w.expiry > ?)), 0),"
            " coalesce(sum(e.received >= ?), 0)"
            " FROM shelf e WHERE e.address = ? AND e.kind = 'entry' AND e.expiry > ?",
            (today, today * MINUTES_PER_DAY, address, today),
        ).fetchone()
        return EntryCounts(live=int(live), today=int(new))

    def read_shelf(
        self, *, after: int, limit: int, today: int, minute: int
    ) -> list[ShelfRow]:
        """Up to ``limit`` unexpired records not held at ``minute``, after ``after``."""
        rows = self._db.execute(
            "SELECT seq, received, address, body FROM shelf"
            " WHERE seq > ? AND expiry > ? AND held_until <= ?"
            " ORDER BY seq LIMIT ?",
            (after, today, minute, limit),
        ).fetchall()
        return [ShelfRow(*row) for row in rows]

    def read_held(
        self, *, after: int, limit: int, today: int, minute: int
    ) -> list[ShelfRow]:
        """Up to ``limit`` unexpired records held at ``minute``, after ``after``."""
        rows = self._db.execute(
            "SELECT seq, received, address, body FROM shelf"
            " WHERE seq > ? AND expiry > ? AND held_until > ?"
            " ORDER BY seq LIMIT ?",
            (after, today, minute, limit),
        ).fetchall()
        return [ShelfRow(*row) for row in rows]

    def shelf_bytes(self, *, today: int) -> int:
        """The bytes of the shelf's unexpired records, as its cap counts them."""
        (used,) = self._db.execute(SHELF_BYTES_SQL, (today,)).fetchone()
        return int(used)

    def delete_expired(self, today: int) -> int:
        """Delete every expired row; return how many.

        Blobs, push subscriptions, backups and shelf records go once their
        expiry day has come. A nudge due before yesterday began was never
        taken by the tick (push was off), so it goes too.
        """
        return (
            self._db.execute("DELETE FROM blobs WHERE expiry <= ?", (today,)).rowcount
            + self._db.execute(
                "DELETE FROM push_subs WHERE expiry <= ?", (today,)
            ).rowcount
            + self._db.execute(
                "DELETE FROM nudges WHERE due < ?", ((today - 1) * MINUTES_PER_DAY,)
            ).rowcount
            + self._db.execute(
                "DELETE FROM backups WHERE expiry <= ?", (today,)
            ).rowcount
            + self._db.execute("DELETE FROM shelf WHERE expiry <= ?", (today,)).rowcount
        )

    def subscribe(self, mailbox: str, endpoint: str, *, expiry: int, keep: int) -> None:
        """Store or refresh ``endpoint`` under ``mailbox``, keeping at most ``keep``.

        Past ``keep``, the rows expiring soonest go first, never the one just
        stored. Ties go by endpoint, since there is no timestamp to break them.
        """
        self._db.execute(
            "INSERT INTO push_subs (mailbox, endpoint, expiry) VALUES (?, ?, ?)"
            " ON CONFLICT (mailbox, endpoint) DO UPDATE SET expiry = excluded.expiry",
            (mailbox, endpoint, expiry),
        )
        (count,) = self._db.execute(
            "SELECT count(*) FROM push_subs WHERE mailbox = ?", (mailbox,)
        ).fetchone()
        if count > keep:
            self._db.execute(
                "DELETE FROM push_subs WHERE mailbox = ? AND endpoint IN"
                " (SELECT endpoint FROM push_subs WHERE mailbox = ? AND endpoint != ?"
                " ORDER BY expiry, endpoint LIMIT ?)",
                (mailbox, mailbox, endpoint, count - keep),
            )

    def unsubscribe(self, mailbox: str, endpoint: str) -> None:
        """Forget ``endpoint`` under ``mailbox``, if it's there."""
        self._db.execute(
            "DELETE FROM push_subs WHERE mailbox = ? AND endpoint = ?",
            (mailbox, endpoint),
        )

    def forget_endpoint(self, endpoint: str) -> None:
        """Forget ``endpoint`` under every mailbox: its subscription is gone."""
        self._db.execute("DELETE FROM push_subs WHERE endpoint = ?", (endpoint,))

    def add_nudge(self, mailbox: str, due: int, *, limit: int) -> bool:
        """Schedule a wake of ``mailbox`` in minute ``due``.

        Returns False, storing nothing, when that would make more than
        ``limit`` pending nudges. A minute already pending is no new nudge.
        """
        if self._db.execute(
            "SELECT 1 FROM nudges WHERE mailbox = ? AND due = ?", (mailbox, due)
        ).fetchone():
            return True
        (count,) = self._db.execute(
            "SELECT count(*) FROM nudges WHERE mailbox = ?", (mailbox,)
        ).fetchone()
        if count >= limit:
            return False
        self._db.execute(
            "INSERT INTO nudges (mailbox, due) VALUES (?, ?)", (mailbox, due)
        )
        return True

    def add_wake(self, mailbox: str, due: int, *, today: int) -> None:
        """Wake ``mailbox`` in minute ``due``, if it has a live endpoint to wake.

        With none, nothing is stored, so no row says which blob mattered.
        """
        self._db.execute(
            "INSERT OR IGNORE INTO nudges (mailbox, due) SELECT ?, ?"
            " WHERE EXISTS (SELECT 1 FROM push_subs WHERE mailbox = ? AND expiry > ?)",
            (mailbox, due, mailbox, today),
        )

    def take_due_nudges(self, minute: int) -> list[str]:
        """Delete every nudge due by ``minute``; return their mailboxes, once each."""
        rows = self._db.execute(
            "DELETE FROM nudges WHERE due <= ? RETURNING mailbox", (minute,)
        ).fetchall()
        return list(dict.fromkeys(mailbox for (mailbox,) in rows))

    def live_endpoints(self, mailboxes: list[str], *, today: int) -> list[str]:
        """The unexpired endpoints of ``mailboxes``, each once, in a stable order."""
        found: dict[str, None] = {}
        for mailbox in mailboxes:
            rows = self._db.execute(
                "SELECT endpoint FROM push_subs WHERE mailbox = ? AND expiry > ?"
                " ORDER BY endpoint",
                (mailbox, today),
            )
            found.update(dict.fromkeys(endpoint for (endpoint,) in rows))
        return list(found)

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
