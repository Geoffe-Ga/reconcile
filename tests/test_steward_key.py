"""The steward's key, made offline (#488, docs/spec/listed-doors.md §6.2).

One 32-byte secret derives both halves the spec names: the Ed25519 key that
signs notices, which the relay's ``RECONCILE_RELAY_SHELF_STEWARD_KEY`` holds,
and the X25519 key reports are sealed to. The client derives them the same
way (``client/src/crypto/steward.ts``), and ``vectors/steward.json`` pins both.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, x25519

from reconcile.relay.settings import Settings, key_bytes
from scripts.steward_key import SEED_BYTES, SeedLengthError, derive, main

VECTOR = (
    Path(__file__).resolve().parents[1]
    / "client"
    / "src"
    / "crypto"
    / "vectors"
    / "steward.json"
)


def _b64url(raw: bytes) -> str:
    """``raw`` in unpadded base64url."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def test_both_halves_derive_from_the_seed_as_the_vector_pins() -> None:
    """The script and the client agree byte for byte (vectors/steward.json)."""
    vector = json.loads(VECTOR.read_text())
    seed = hashlib.sha256(b"reconcile/vector/steward").digest()
    assert bytes(vector["seed"]) == seed

    keys = derive(seed)

    assert keys.sign_public == bytes(vector["signPublic"])
    assert keys.box_public == bytes(vector["boxPublic"])
    assert vector["signInfo"] == "reconcile/v1/steward-sign"
    assert vector["boxInfo"] == "reconcile/v1/steward-box"


def test_the_halves_are_real_key_pairs_of_their_derived_secrets() -> None:
    """Each public half is its own curve's key of the HKDF output under its label."""
    seed = bytes(range(SEED_BYTES))
    keys = derive(seed)
    sign_secret = keys.sign_secret
    signer = ed25519.Ed25519PrivateKey.from_private_bytes(sign_secret)
    boxer = x25519.X25519PrivateKey.from_private_bytes(keys.box_secret)
    raw = (serialization.Encoding.Raw, serialization.PublicFormat.Raw)

    assert signer.public_key().public_bytes(*raw) == keys.sign_public
    assert boxer.public_key().public_bytes(*raw) == keys.box_public
    assert len({sign_secret, keys.box_secret, seed}) == 3


@pytest.mark.parametrize("length", [0, 31, 33])
def test_a_seed_of_any_other_length_is_refused(length: int) -> None:
    """The secret the steward imports is exactly 32 bytes."""
    with pytest.raises(SeedLengthError, match="32 bytes"):
        derive(b"\x01" * length)


def _printed(capsys: pytest.CaptureFixture[str]) -> dict[str, str]:
    """One run of ``main``: each ``label: value`` and ``NAME=value`` line, by label."""
    assert main([]) == 0
    out = capsys.readouterr().out
    pairs = [line.split(": ", 1) for line in out.splitlines() if ": " in line]
    settings = [
        line.split("=", 1) for line in out.splitlines() if line.startswith("RECONCILE_")
    ]
    return {**dict(pairs), **dict(settings)}


def test_main_prints_the_secret_and_both_public_keys(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The secret once, the deploy build's two pins (#505), and the relay's line."""
    lines = _printed(capsys)
    secret = lines["Steward secret (import in Settings, then keep offline)"]
    keys = derive(base64.urlsafe_b64decode(secret + "="))
    sign = _b64url(keys.sign_public)

    assert lines["RECONCILE_STEWARD_PIN_SIGN"] == sign
    assert lines["RECONCILE_STEWARD_PIN_BOX"] == _b64url(keys.box_public)
    assert lines["RECONCILE_RELAY_SHELF_STEWARD_KEY"] == sign
    env = {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_SHELF_STEWARD_KEY": sign}
    assert Settings.from_env(env).shelf_steward_key == sign
    assert key_bytes(sign) == keys.sign_public


def test_main_says_where_each_setting_goes(capsys: pytest.CaptureFixture[str]) -> None:
    """The pins go to the deploy build's environment, never into source (#505)."""
    assert main([]) == 0
    out = capsys.readouterr().out.splitlines()

    build = out.index("Set both for the deploy build (deploy/.env or its environment):")
    relay = out.index("Set this on the relay (a reconcile-relay.service drop-in):")
    assert out[build + 1].startswith("RECONCILE_STEWARD_PIN_SIGN=")
    assert out[build + 2].startswith("RECONCILE_STEWARD_PIN_BOX=")
    assert out[relay + 1].startswith("RECONCILE_RELAY_SHELF_STEWARD_KEY=")
    assert "pin as" not in "\n".join(out)


def test_main_makes_a_new_secret_each_run(capsys: pytest.CaptureFixture[str]) -> None:
    """Two runs never print the same secret."""
    label = "Steward secret (import in Settings, then keep offline)"

    assert _printed(capsys)[label] != _printed(capsys)[label]


def test_main_refuses_arguments(capsys: pytest.CaptureFixture[str]) -> None:
    """It takes none: the secret is never read from, or written to, a file."""
    assert main(["--seed", "x"]) == 2
    assert "Usage" in capsys.readouterr().err
