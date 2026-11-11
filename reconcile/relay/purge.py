"""Delete expired rows, then truncate the WAL: ``python -m reconcile.relay.purge``.

Run it daily (#68 adds the timer). It deletes rows whose expiry day has come,
blobs and backups (#97) alike, then runs ``PRAGMA wal_checkpoint(TRUNCATE)``
so deleted blobs don't linger in the WAL. With ``secure_delete`` on, SQLite
zeroes them in the main file too.
It prints nothing: even a count of deleted rows says how busy the relay was.
"""

from __future__ import annotations

import time

from reconcile.relay.settings import Settings
from reconcile.relay.store import BlobStore, day_of


def purge(store: BlobStore, now: float) -> int:
    """Delete the rows expired at unix time ``now``, then checkpoint.

    Returns the number of rows deleted.
    """
    deleted = store.delete_expired(day_of(now))
    store.checkpoint()
    return deleted


def main() -> int:
    """Purge the database named by ``RECONCILE_RELAY_DB`` as of now."""
    with BlobStore(Settings.from_env().db_path) as store:
        purge(store, time.time())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
