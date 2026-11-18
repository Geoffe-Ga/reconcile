"""What the relay reads of a public shelf record (#484, listed-doors.md §4.1-§4.2).

A shelf record is a 64-byte Ed25519 signature, then the record's compact
UTF-8 JSON. The signature covers ``reconcile/v1/shelf``, one 0x00 byte, then
the JSON, under the key the record is PUT to: a listed door's ``sign`` key
for a group's records (ADR-0081). The address travels in the path, so the
record doesn't carry it again.

These are the only bodies the relay can read, and it reads as little as it
can: the signature, ``v`` and ``kind``, and an entry's or withdraw's ``id``,
which it files the record under. It never reads a name, a title or a text.

Every device verifies each record again under strict RFC 8032 rules
(``client/src/crypto/shelf.ts``), so a record this check lets through that a
device's wouldn't is stored and then ignored everywhere; the relay is never
the only check.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# The tag before the 0x00 byte, as client/src/crypto/sign.ts names it.
SHELF_CONTEXT = b"reconcile/v1/shelf"
SIGNATURE_BYTES = 64

# The largest record of each kind, signature included (listed-doors.md §4.1,
# proposed): an entry carries a title and a text, the rest only a little.
MAX_ENTRY_BYTES = 4096
MAX_SMALL_BYTES = 1024
MAX_RECORD_BYTES = MAX_ENTRY_BYTES
_MAX_BYTES = {
    "listing": MAX_SMALL_BYTES,
    "entry": MAX_ENTRY_BYTES,
    "withdraw": MAX_SMALL_BYTES,
}
# The kinds filed under the id they name. A notice is the steward's (#488).
_REFERS = frozenset({"entry", "withdraw"})


@dataclass(frozen=True)
class Refusal:
    """Why a record isn't stored: an HTTP status and the constant error code."""

    status: int
    code: str


BAD_SIGNATURE = Refusal(403, "bad_signature")
INVALID_RECORD = Refusal(400, "invalid_record")
TOO_LARGE = Refusal(413, "too_large")


@dataclass(frozen=True)
class ShelfRecord:
    """What the relay files a record under: its kind, and the id it names or ``""``."""

    kind: str
    ref: str


def open_record(key: bytes, body: bytes) -> ShelfRecord | Refusal:
    """Check ``body`` against the 32-byte public ``key`` and read what it's filed under.

    In order: a signature and at least one byte of message (else
    ``invalid_record``), the signature (else ``bad_signature``), a v1
    listing, entry or withdraw (else ``invalid_record``), then the kind's
    size (else ``too_large``). Unsigned bytes are never parsed.
    """
    if len(body) <= SIGNATURE_BYTES:
        return INVALID_RECORD
    signature, message = body[:SIGNATURE_BYTES], body[SIGNATURE_BYTES:]
    if not _verifies(key, signature, message):
        return BAD_SIGNATURE
    record = _parse(message)
    if record is None:
        return INVALID_RECORD
    if len(body) > _MAX_BYTES[record.kind]:
        return TOO_LARGE
    return record


def _verifies(key: bytes, signature: bytes, message: bytes) -> bool:
    """Whether ``signature`` is ``key``'s over the shelf tag, 0x00 and ``message``."""
    try:
        Ed25519PublicKey.from_public_bytes(key).verify(
            signature, SHELF_CONTEXT + b"\x00" + message
        )
    except (InvalidSignature, ValueError):
        return False
    return True


def _parse(message: bytes) -> ShelfRecord | None:
    """The kind and id of a v1 record's JSON, or ``None`` for anything else."""
    try:
        body = json.loads(message.decode("utf-8"), object_pairs_hook=_unique_keys)
    except (ValueError, RecursionError):
        return None
    if not isinstance(body, dict) or not _is_v1(body.get("v")):
        return None
    kind = body.get("kind")
    if not isinstance(kind, str) or kind not in _MAX_BYTES:
        return None
    if kind not in _REFERS:
        return ShelfRecord(kind, "")
    ref = body.get("id")
    return ShelfRecord(kind, ref) if isinstance(ref, str) else None


def _is_v1(value: object) -> bool:
    """Whether ``value`` is the integer 1, and not ``True``."""
    return isinstance(value, int) and not isinstance(value, bool) and value == 1


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Build a JSON object, refusing one that names a key twice."""
    body = dict(pairs)
    if len(body) != len(pairs):
        raise ValueError
    return body
