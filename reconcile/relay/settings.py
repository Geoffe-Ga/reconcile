"""Relay settings, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

DB_ENV = "RECONCILE_RELAY_DB"
MAX_DB_BYTES_ENV = "RECONCILE_RELAY_MAX_DB_BYTES"
VAPID_KEY_ENV = "RECONCILE_RELAY_VAPID_KEY"
VAPID_SUBJECT_ENV = "RECONCILE_RELAY_VAPID_SUBJECT"
DEFAULT_MAX_DB_BYTES = 1 << 30  # 1 GiB

_EXPECTED = {
    DB_ENV: "the path of the relay's SQLite file",
    MAX_DB_BYTES_ENV: "a positive whole number of bytes",
    VAPID_KEY_ENV: "the path of a PEM P-256 private key the relay can read",
    VAPID_SUBJECT_ENV: (
        "https://<domain> or mailto:<address>, naming neither localhost"
        " nor an IP address"
    ),
}


class SettingsError(ValueError):
    """An environment variable the relay reads is missing or malformed."""

    def __init__(self, variable: str) -> None:
        """Name ``variable`` and say what it must hold."""
        super().__init__(f"{variable} must be {_EXPECTED[variable]}")
        self.variable = variable


@dataclass(frozen=True)
class Settings:
    """What the relay needs to run.

    Attributes:
        db_path: The SQLite file holding the blobs. Required: only
            ``scripts/relay.sh`` supplies a default, for local runs.
        max_db_bytes: PUTs are refused once the database plus its WAL is
            larger than this.
        vapid_key: The PEM P-256 private key that signs Web Push requests
            (RFC 8292). ``None`` turns push off: its routes answer
            ``push_unavailable`` and a blob PUT's ``wake`` does nothing.
        vapid_subject: The ``sub`` every push request names. ``create_app``
            checks it once a key is set (``reconcile.relay.push``).
    """

    db_path: Path
    max_db_bytes: int = DEFAULT_MAX_DB_BYTES
    vapid_key: Path | None = None
    vapid_subject: str = ""

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """Read the settings from ``environ``, or the process environment.

        An unset or empty ``RECONCILE_RELAY_VAPID_KEY`` leaves push off.

        Raises:
            SettingsError: ``RECONCILE_RELAY_DB`` is unset or empty, or
                ``RECONCILE_RELAY_MAX_DB_BYTES`` isn't a positive integer.
        """
        env = os.environ if environ is None else environ
        db_path = env.get(DB_ENV, "")
        if not db_path:
            raise SettingsError(DB_ENV)
        vapid_key = env.get(VAPID_KEY_ENV, "")
        return cls(
            db_path=Path(db_path),
            max_db_bytes=_max_db_bytes(env),
            vapid_key=Path(vapid_key) if vapid_key else None,
            vapid_subject=env.get(VAPID_SUBJECT_ENV, ""),
        )


def _max_db_bytes(env: Mapping[str, str]) -> int:
    """Parse the size cap, falling back to the default when it's unset."""
    raw = env.get(MAX_DB_BYTES_ENV)
    if raw is None:
        return DEFAULT_MAX_DB_BYTES
    if not (raw.isascii() and raw.isdigit()) or int(raw) == 0:
        raise SettingsError(MAX_DB_BYTES_ENV)
    return int(raw)
