"""Relay settings, read once from the environment."""

from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from collections.abc import Mapping

DB_ENV = "RECONCILE_RELAY_DB"
MAX_DB_BYTES_ENV = "RECONCILE_RELAY_MAX_DB_BYTES"
MAX_MAILBOX_BYTES_ENV = "RECONCILE_RELAY_MAX_MAILBOX_BYTES"
VAPID_KEY_ENV = "RECONCILE_RELAY_VAPID_KEY"
VAPID_SUBJECT_ENV = "RECONCILE_RELAY_VAPID_SUBJECT"
SHELF_STEWARD_KEY_ENV = "RECONCILE_RELAY_SHELF_STEWARD_KEY"
SHELF_MAX_BYTES_ENV = "RECONCILE_RELAY_SHELF_MAX_BYTES"
SHELF_MODE_ENV = "RECONCILE_RELAY_SHELF_MODE"
# The one shelf mode built (#488, listed-doors.md §4.2): every new listing
# waits for the steward. Open mode is deferred (§9).
HELD_MODE = "held"
DEFAULT_MAX_DB_BYTES = 1 << 30  # 1 GiB
# 64 MiB: over four times a busy 15-person group's worst 30 days, and 1/16 of
# the relay's default cap (ADR-0028's amendment of 2026-11-10, #141).
DEFAULT_MAX_MAILBOX_BYTES = 1 << 26
# 64 MiB for the whole public shelf (docs/spec/listed-doors.md §4.2, proposed).
DEFAULT_MAX_SHELF_BYTES = 1 << 26
_BASE64URL_KEY = re.compile(r"[A-Za-z0-9_-]{43}")

_EXPECTED = {
    DB_ENV: "the path of the relay's SQLite file",
    MAX_DB_BYTES_ENV: "a positive whole number of bytes",
    MAX_MAILBOX_BYTES_ENV: "a positive whole number of bytes",
    VAPID_KEY_ENV: "the path of a PEM P-256 private key the relay can read",
    VAPID_SUBJECT_ENV: (
        "https://<domain> or mailto:<address>, naming neither localhost"
        " nor an IP address"
    ),
    SHELF_STEWARD_KEY_ENV: (
        "an Ed25519 public key: 43 characters of canonical unpadded base64url"
    ),
    SHELF_MAX_BYTES_ENV: "a positive whole number of bytes",
    SHELF_MODE_ENV: "held, or unset: open mode is deferred (listed-doors.md §9)",
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
        max_mailbox_bytes: A blob PUT is refused when it would take its
            mailbox's unexpired blobs past this many bytes, so no one
            mailbox can fill the relay for every group (#141).
        vapid_key: The PEM P-256 private key that signs Web Push requests
            (RFC 8292). ``None`` turns push off: its routes answer
            ``push_unavailable`` and a blob PUT's ``wake`` does nothing.
        vapid_subject: The ``sub`` every push request names. ``create_app``
            checks it once a key is set (``reconcile.relay.push``).
        shelf_steward_key: The steward's Ed25519 public key, in unpadded
            base64url (#484, ADR-0081). ``None`` turns the public shelf off:
            its routes answer ``shelf_unavailable``.
        max_shelf_bytes: A shelf PUT is refused with ``shelf_full`` when it
            would take the shelf's unexpired records past this many bytes.
        shelf_mode: ``held``, the only mode built (#488): an address's first
            listing, and everything under it, waits until a ``release``
            notice the steward signed clears it.
    """

    db_path: Path
    max_db_bytes: int = DEFAULT_MAX_DB_BYTES
    max_mailbox_bytes: int = DEFAULT_MAX_MAILBOX_BYTES
    vapid_key: Path | None = None
    vapid_subject: str = ""
    shelf_steward_key: str | None = None
    max_shelf_bytes: int = DEFAULT_MAX_SHELF_BYTES
    shelf_mode: Literal["held"] = "held"

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """Read the settings from ``environ``, or the process environment.

        An unset or empty ``RECONCILE_RELAY_VAPID_KEY`` leaves push off, and
        an unset or empty ``RECONCILE_RELAY_SHELF_STEWARD_KEY`` the shelf.
        An unset or empty ``RECONCILE_RELAY_SHELF_MODE`` is held mode.

        Raises:
            SettingsError: ``RECONCILE_RELAY_DB`` is unset or empty, a size
                cap is set but isn't a positive integer, the steward key
                is set but isn't a canonical 32-byte key, or the shelf mode
                is set to anything but ``held``.
        """
        env = os.environ if environ is None else environ
        db_path = env.get(DB_ENV, "")
        if not db_path:
            raise SettingsError(DB_ENV)
        vapid_key = env.get(VAPID_KEY_ENV, "")
        return cls(
            db_path=Path(db_path),
            max_db_bytes=_bytes(env, MAX_DB_BYTES_ENV, DEFAULT_MAX_DB_BYTES),
            max_mailbox_bytes=_bytes(
                env, MAX_MAILBOX_BYTES_ENV, DEFAULT_MAX_MAILBOX_BYTES
            ),
            vapid_key=Path(vapid_key) if vapid_key else None,
            vapid_subject=env.get(VAPID_SUBJECT_ENV, ""),
            shelf_steward_key=_steward_key(env),
            max_shelf_bytes=_bytes(env, SHELF_MAX_BYTES_ENV, DEFAULT_MAX_SHELF_BYTES),
            shelf_mode=_shelf_mode(env),
        )


def _bytes(env: Mapping[str, str], variable: str, default: int) -> int:
    """Parse the size cap in ``variable``, or ``default`` when it's unset."""
    raw = env.get(variable)
    if raw is None:
        return default
    if not (raw.isascii() and raw.isdigit()) or int(raw) == 0:
        raise SettingsError(variable)
    return int(raw)


def key_bytes(text: str) -> bytes | None:
    """The 32 bytes ``text`` spells in canonical unpadded base64url, else ``None``.

    43 characters carry 258 bits, so a set spare bit in the last one would
    spell the same key a second way; that spelling is refused.
    """
    if _BASE64URL_KEY.fullmatch(text) is None:
        return None
    raw = base64.urlsafe_b64decode(text + "=")  # 43 such characters always decode
    canonical = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    return raw if canonical == text else None


def _steward_key(env: Mapping[str, str]) -> str | None:
    """The steward's key, ``None`` when unset or empty; else it must be canonical."""
    raw = env.get(SHELF_STEWARD_KEY_ENV, "")
    if not raw:
        return None
    if key_bytes(raw) is None:
        raise SettingsError(SHELF_STEWARD_KEY_ENV)
    return raw


def _shelf_mode(env: Mapping[str, str]) -> Literal["held"]:
    """``held`` when the mode is unset, empty or ``held``; any other is refused."""
    if env.get(SHELF_MODE_ENV, "") not in ("", HELD_MODE):
        raise SettingsError(SHELF_MODE_ENV)
    return "held"
