#!/usr/bin/env python3
"""Make the steward's key, offline (#488, docs/spec/listed-doors.md §6.2).

The steward is the platform's moderator, the founder during the pilot
(ADR-0081). One fresh 32-byte secret derives both of the steward's keys,
each by HKDF-SHA-256 with an empty salt under a label of its own:

- ``reconcile/v1/steward-sign``: the Ed25519 key that signs notices. Its
  public half is pinned in ``client/src/shelf/steward.ts`` as ``sign`` and
  set as the relay's ``RECONCILE_RELAY_SHELF_STEWARD_KEY``.
- ``reconcile/v1/steward-box``: the X25519 key reports are sealed to (#489).
  Its public half is pinned as ``box``.

The client derives them the same way (``client/src/crypto/steward.ts``), and
``client/src/crypto/vectors/steward.json`` pins both. The secret is printed
once, to be imported in Settings, under Steward key, on the steward's one device
and then kept offline; this script keeps no copy and writes no file.

Usage:
    python -m scripts.steward_key
"""

from __future__ import annotations

import base64
import secrets
import sys
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, x25519
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

SEED_BYTES = 32
SIGN_INFO = b"reconcile/v1/steward-sign"
BOX_INFO = b"reconcile/v1/steward-box"
_RAW = (serialization.Encoding.Raw, serialization.PublicFormat.Raw)


class SeedLengthError(ValueError):
    """The steward's secret isn't 32 bytes."""

    def __init__(self) -> None:
        """Say how long the secret must be."""
        super().__init__("The steward's secret is 32 bytes.")


@dataclass(frozen=True)
class StewardKeys:
    """The steward's two key pairs, each half 32 bytes."""

    sign_secret: bytes
    sign_public: bytes
    box_secret: bytes
    box_public: bytes


def _hkdf(seed: bytes, info: bytes) -> bytes:
    """HKDF-SHA-256 of ``seed`` under ``info``, with an empty salt: 32 bytes."""
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(seed)


def derive(seed: bytes) -> StewardKeys:
    """Both of the steward's key pairs from the 32-byte ``seed``.

    Raises:
        SeedLengthError: ``seed`` isn't 32 bytes.
    """
    if len(seed) != SEED_BYTES:
        raise SeedLengthError
    sign_secret = _hkdf(seed, SIGN_INFO)
    box_secret = _hkdf(seed, BOX_INFO)
    signer = ed25519.Ed25519PrivateKey.from_private_bytes(sign_secret)
    boxer = x25519.X25519PrivateKey.from_private_bytes(box_secret)
    return StewardKeys(
        sign_secret=sign_secret,
        sign_public=signer.public_key().public_bytes(*_RAW),
        box_secret=box_secret,
        box_public=boxer.public_key().public_bytes(*_RAW),
    )


def _b64url(raw: bytes) -> str:
    """``raw`` in unpadded base64url, as the app and the relay spell keys."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def main(argv: list[str] | None = None) -> int:
    """Print a new steward secret, its two public keys and the relay's setting."""
    args = sys.argv[1:] if argv is None else argv
    if args:
        print(
            "Usage: python -m scripts.steward_key (takes no arguments)", file=sys.stderr
        )
        return 2
    seed = secrets.token_bytes(SEED_BYTES)
    keys = derive(seed)
    print(f"Steward secret (import in Settings, then keep offline): {_b64url(seed)}")
    print(f"Sign public key (pin as sign): {_b64url(keys.sign_public)}")
    print(f"Box public key (pin as box): {_b64url(keys.box_public)}")
    print(f"RECONCILE_RELAY_SHELF_STEWARD_KEY={_b64url(keys.sign_public)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
