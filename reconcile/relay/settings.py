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
DEFAULT_MAX_DB_BYTES = 1 << 30  # 1 GiB

_EXPECTED = {
    DB_ENV: "the path of the relay's SQLite file",
    MAX_DB_BYTES_ENV: "a positive whole number of bytes",
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
    """

    db_path: Path
    max_db_bytes: int = DEFAULT_MAX_DB_BYTES

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """Read the settings from ``environ``, or the process environment.

        Raises:
            SettingsError: ``RECONCILE_RELAY_DB`` is unset or empty, or
                ``RECONCILE_RELAY_MAX_DB_BYTES`` isn't a positive integer.
        """
        env = os.environ if environ is None else environ
        db_path = env.get(DB_ENV, "")
        if not db_path:
            raise SettingsError(DB_ENV)
        return cls(db_path=Path(db_path), max_db_bytes=_max_db_bytes(env))


def _max_db_bytes(env: Mapping[str, str]) -> int:
    """Parse the size cap, falling back to the default when it's unset."""
    raw = env.get(MAX_DB_BYTES_ENV)
    if raw is None:
        return DEFAULT_MAX_DB_BYTES
    if not (raw.isascii() and raw.isdigit()) or int(raw) == 0:
        raise SettingsError(MAX_DB_BYTES_ENV)
    return int(raw)
