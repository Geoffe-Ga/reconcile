"""What the relay reads of a public shelf record (#484, listed-doors.md §4.1-§4.2).

A shelf record is a 64-byte Ed25519 signature, then the record's compact
UTF-8 JSON. The signature covers ``reconcile/v1/shelf``, one 0x00 byte, then
the JSON, under the key the record is PUT to: a listed door's ``sign`` key
for a group's records (ADR-0081). The address travels in the path, so the
record doesn't carry it again.

These are the only bodies the relay can read, and it reads as little as it
can: the signature, ``v`` and ``kind``, an entry's or withdraw's ``id``,
which it files the record under, a listing's ``open`` and ``final``, which
say whether the door has closed for good (#486), and a notice's ``act``,
``address``, ``id``, ``clause`` and ``on`` (#488, #489). It never reads a
name, a title or a text.

A notice is the steward's (listed-doors.md §6.1); the route checks that the
steward signed it. Each act names what it acts on, and a notice missing any
of it is no record:

- ``release``: an ``address``, whose hold it clears (#488).
- ``hold``: an ``address`` and a ``clause``, and an entry's ``id`` when it
  holds one entry rather than the whole address.
- ``uphold``: an ``address``, an entry's ``id`` and a ``clause``.
- ``suspend``: an ``address`` and a ``clause``.
- ``pause``: ``on``, true or false (#489's encoding of "on or off").

A notice is filed under a ``ref`` that says what it acts on, so the relay
can find it again: a release under the address it names, as #488 filed it,
and the others under ``hold:{address}``, ``hold:{address}:{id}``,
``uphold:{address}:{id}``, ``suspend:{address}`` or ``pause``.

Every device verifies each record again under strict RFC 8032 rules
(``client/src/crypto/shelf.ts``), so a record this check lets through that a
device's wouldn't is stored and then ignored everywhere; the relay is never
the only check.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, TypeGuard

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from reconcile.relay.settings import key_bytes

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
    "notice": MAX_SMALL_BYTES,
}
# The kinds filed under the id they name; a listing is filed under none, and a
# notice under the address it names.
_REFERS = frozenset({"entry", "withdraw"})
# The acts a notice takes (§6.1).
RELEASE = "release"
HOLD = "hold"
UPHOLD = "uphold"
SUSPEND = "suspend"
PAUSE = "pause"
# The covenant's clauses a hold, uphold or suspend names (§6.1).
CLAUSES = frozenset({"C1", "C2", "C3"})


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
    """What the relay files a record under: its kind, and the id it names or ``""``.

    ``final`` is true only for a final listing, ``{v: 1, kind: "listing",
    open: false, final: true}``: its door has closed for good (#486). A
    notice's ``ref`` says what it acts on (the module's docstring), and
    ``notice`` holds what the route acts on.
    """

    kind: str
    ref: str
    final: bool = False
    notice: Notice | None = None


@dataclass(frozen=True)
class Notice:
    """What a steward's notice acts on: its act, the address and the entry it names."""

    act: str
    address: str = ""
    entry: str = ""

    @property
    def ref(self) -> str:
        """What the notice is filed under: a release under its address, else by act."""
        if self.act == RELEASE:
            return self.address
        return ":".join(part for part in (self.act, self.address, self.entry) if part)


def open_record(key: bytes, body: bytes) -> ShelfRecord | Refusal:
    """Check ``body`` against the 32-byte public ``key`` and read what it's filed under.

    In order: a signature and at least one byte of message (else
    ``invalid_record``), the signature (else ``bad_signature``), a v1
    listing, entry, withdraw or release notice (else ``invalid_record``),
    then the kind's size (else ``too_large``). Unsigned bytes are never
    parsed. A listing is open (``open`` is ``true``) or final (``open`` is
    ``false`` and ``final`` is ``true``); any other is no record.
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
    if kind == "notice":
        return _notice(body)
    if kind not in _REFERS:
        return _listing(body)
    ref = body.get("id")
    return ShelfRecord(kind, ref) if isinstance(ref, str) else None


def _listing(body: dict[str, Any]) -> ShelfRecord | None:
    """An open or final listing, or ``None`` for a listing that is neither."""
    if body.get("open") is True:
        return ShelfRecord("listing", "")
    if body.get("open") is False and body.get("final") is True:
        return ShelfRecord("listing", "", final=True)
    return None


def _notice(body: dict[str, Any]) -> ShelfRecord | None:
    """A notice that names all its act names, filed by its ``ref``; else ``None``."""
    notice = _acts_on(body)
    return None if notice is None else ShelfRecord("notice", notice.ref, notice=notice)


def _acts_on(body: dict[str, Any]) -> Notice | None:
    """What ``body``'s act acts on, when it names everything that act needs."""
    act = body.get("act")
    if act == PAUSE:
        return Notice(PAUSE) if isinstance(body.get("on"), bool) else None
    address = body.get("address")
    if not _is_key(address):
        return None
    if act == RELEASE:
        return Notice(RELEASE, address)
    if act not in {HOLD, UPHOLD, SUSPEND} or not _is_clause(body.get("clause")):
        return None
    return _with_entry(str(act), address, body.get("id"))


def _with_entry(act: str, address: str, entry: object) -> Notice | None:
    """A hold, uphold or suspend: an uphold names an entry, a suspend none."""
    if entry is None:
        return None if act == UPHOLD else Notice(act, address)
    if act == SUSPEND or not _is_key(entry):
        return None
    return Notice(act, address, entry)


def _is_key(value: object) -> TypeGuard[str]:
    """Whether ``value`` spells 32 bytes in canonical unpadded base64url."""
    return isinstance(value, str) and key_bytes(value) is not None


def _is_clause(value: object) -> bool:
    """Whether ``value`` names one of the covenant's clauses."""
    return isinstance(value, str) and value in CLAUSES


def is_final(body: bytes) -> bool:
    """Whether the stored record ``body`` (checked when it came) is a final listing."""
    record = _parse(body[SIGNATURE_BYTES:])
    return record is not None and record.final


def _is_v1(value: object) -> bool:
    """Whether ``value`` is the integer 1, and not ``True``."""
    return isinstance(value, int) and not isinstance(value, bool) and value == 1


def _unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Build a JSON object, refusing one that names a key twice."""
    body = dict(pairs)
    if len(body) != len(pairs):
        raise ValueError
    return body
