"""Push is on only with a good VAPID key and subject; without a key it is off.

With a key, ``create_app`` checks the subject push services will see, and
refuses one they would reject or that names a machine (#89). Without one,
every push route says ``push_unavailable`` and the mailbox works as before.
"""

from __future__ import annotations

import base64
import shutil
import subprocess
from typing import TYPE_CHECKING, Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from starlette.testclient import TestClient

from reconcile.relay.app import create_app
from reconcile.relay.push import load_vapid
from reconcile.relay.settings import Settings, SettingsError
from tests.relay.helpers import (
    SUBJECT,
    mailbox_id,
    nudge,
    nudge_rows,
    push_endpoint,
    row_count,
    store_of,
    subscribe,
    unsubscribe,
    wake_put,
    write_vapid_key,
)

if TYPE_CHECKING:
    from pathlib import Path

    from tests.relay.helpers import FakeClock

OPENSSL = shutil.which("openssl")


def _push_app(db_path: Path, key: Path | None, subject: str, clock: FakeClock) -> Any:
    """``create_app`` with this key and subject."""
    return create_app(
        Settings(db_path=db_path, vapid_key=key, vapid_subject=subject), clock
    )


# --- The subject -----------------------------------------------------------


@pytest.mark.parametrize(
    "subject",
    [
        "",
        "mailto:",
        "mailto:@example.org",
        "mailto:founder@",
        "mailto:founder@localhost",
        "mailto:founder@10.0.0.1",
        "mailto:founder@[10.0.0.1]",
        "mailto:a@b@example.org",
        "https://",
        "https://localhost",
        "https://relay.localhost",
        "https://10.0.0.1",
        "https://[::1]",
        "https://[2001:db8::1]",
        "https://example",
        "https://relay.example.org/",
        "https://relay.example.org/contact",
        "https://relay.example.org:443",
        "https://founder@relay.example.org",
        "http://relay.example.org",
        "relay.example.org",
        "ftp://relay.example.org",
        " https://relay.example.org",
        "https://relay.example.org\n",
        "https://relay..example.org",
        "https://-relay.example.org",
        "https://relay.example.org.",
        "https://relay.exämple.org",
    ],
)
def test_a_bad_subject_fails_create_app(
    db_path: Path, vapid_key: Path, clock: FakeClock, subject: str
) -> None:
    """With a key set, a subject that's empty, local or an address is refused."""
    with pytest.raises(SettingsError, match="RECONCILE_RELAY_VAPID_SUBJECT"):
        _push_app(db_path, vapid_key, subject, clock)


@pytest.mark.parametrize(
    "subject",
    [
        SUBJECT,
        "https://reconcile.example",
        "https://xn--rconcile-byb.example.org",
        "https://Relay.Example.Org",
        "mailto:founder@example.org",
        "mailto:first.last+relay@mail.example.org",
    ],
)
def test_a_good_subject_starts_the_relay_and_signs(
    db_path: Path, vapid_key: Path, clock: FakeClock, subject: str
) -> None:
    """An https:// domain or a mailto: address on a domain is accepted.

    py-vapid checks ``sub`` again on every signature, so a subject the relay
    accepted but py-vapid refused would make every push fail, silently.
    """
    relay = _push_app(db_path, vapid_key, subject, clock)
    store_of(relay).close()
    vapid = load_vapid(
        Settings(db_path=db_path, vapid_key=vapid_key, vapid_subject=subject)
    )
    assert vapid is not None

    signed = vapid.signer.sign(
        {"aud": "https://web.push.apple.com", "exp": int(clock()) + 60, "sub": subject}
    )

    assert set(signed) == {"Authorization"}
    assert signed["Authorization"].startswith("vapid t=")


def test_the_subject_is_ignored_without_a_key(db_path: Path, clock: FakeClock) -> None:
    """A subject alone doesn't turn push on, so it isn't checked."""
    relay = _push_app(db_path, None, "https://localhost", clock)
    try:
        with TestClient(relay) as client:
            response = client.get("/v1/push/key")
    finally:
        store_of(relay).close()

    assert response.json() == {"error": "push_unavailable"}


# --- The key ---------------------------------------------------------------


def test_a_missing_key_file_fails_create_app(
    db_path: Path, tmp_path: Path, clock: FakeClock
) -> None:
    """The relay never makes its own key: deploy.sh does, once."""
    with pytest.raises(SettingsError, match="RECONCILE_RELAY_VAPID_KEY"):
        _push_app(db_path, tmp_path / "absent.pem", SUBJECT, clock)
    assert not (tmp_path / "absent.pem").exists()


@pytest.mark.parametrize(
    "make",
    [
        pytest.param(lambda: b"", id="empty"),
        pytest.param(lambda: b"not a key", id="garbage"),
        pytest.param(
            lambda: ec.generate_private_key(ec.SECP384R1()).private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ),
            id="P-384",
        ),
        pytest.param(
            lambda: ec.generate_private_key(ec.SECP256R1()).private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.BestAvailableEncryption(b"passphrase"),
            ),
            id="encrypted",
        ),
        pytest.param(
            lambda: (
                ec.generate_private_key(ec.SECP256R1())
                .public_key()
                .public_bytes(
                    serialization.Encoding.PEM,
                    serialization.PublicFormat.SubjectPublicKeyInfo,
                )
            ),
            id="public-key",
        ),
    ],
)
def test_a_key_that_isnt_a_p256_private_key_fails_create_app(
    db_path: Path, tmp_path: Path, clock: FakeClock, make: Any
) -> None:
    """Only an unencrypted PEM P-256 private key turns push on."""
    key = tmp_path / "vapid.pem"
    key.write_bytes(make())

    with pytest.raises(SettingsError, match="RECONCILE_RELAY_VAPID_KEY"):
        _push_app(db_path, key, SUBJECT, clock)


def test_a_pkcs8_key_is_accepted(
    db_path: Path, tmp_path: Path, clock: FakeClock
) -> None:
    """A PKCS #8 PEM works as well as OpenSSL's traditional EC format."""
    key = tmp_path / "vapid.pem"
    key.write_bytes(
        ec.generate_private_key(ec.SECP256R1()).private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )

    store_of(_push_app(db_path, key, SUBJECT, clock)).close()


@pytest.mark.skipif(OPENSSL is None, reason="needs the openssl CLI")
def test_the_key_deploy_sh_makes_is_accepted(
    db_path: Path, tmp_path: Path, clock: FakeClock
) -> None:
    """``openssl ecparam -name prime256v1 -genkey -noout`` makes a usable key."""
    key = tmp_path / "vapid.pem"
    subprocess.run(
        [str(OPENSSL), "ecparam", "-name", "prime256v1", "-genkey", "-noout"],
        stdout=key.open("wb"),
        check=True,
    )
    relay = _push_app(db_path, key, SUBJECT, clock)
    try:
        with TestClient(relay) as client:
            assert client.get("/v1/push/key").status_code == 200
    finally:
        store_of(relay).close()


def test_the_key_route_serves_the_uncompressed_public_point(
    db_path: Path, tmp_path: Path, clock: FakeClock
) -> None:
    """``GET /v1/push/key``: 65 bytes as 87 unpadded base64url characters."""
    path = tmp_path / "vapid.pem"
    private = write_vapid_key(path)
    expected = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    relay = _push_app(db_path, path, SUBJECT, clock)
    try:
        with TestClient(relay) as client:
            response = client.get("/v1/push/key")
    finally:
        store_of(relay).close()

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"vapid_public_key"}
    key = body["vapid_public_key"]
    assert len(key) == 87
    assert "=" not in key
    assert base64.urlsafe_b64decode(key + "=") == expected
    assert expected[0] == 0x04
    assert len(expected) == 65


# --- Push off --------------------------------------------------------------


@pytest.fixture
def mailbox() -> str:
    """A mailbox for the push-off checks."""
    return mailbox_id()


def test_without_a_key_every_push_route_is_unavailable(
    client: TestClient, db_path: Path, mailbox: str
) -> None:
    """Each push route answers 404 push_unavailable and stores nothing."""
    responses = [
        client.get("/v1/push/key"),
        subscribe(client, mailbox, push_endpoint()),
        unsubscribe(client, mailbox, push_endpoint()),
        nudge(client, mailbox, 0),
        client.put("/v1/push/not-a-mailbox", content=b"{}"),
    ]

    for response in responses:
        assert response.status_code == 404
        assert response.content == b'{"error":"push_unavailable"}'
    assert nudge_rows(db_path) == []


def test_without_a_key_wake_stores_the_blob_and_no_nudge(
    client: TestClient, db_path: Path, mailbox: str
) -> None:
    """``wake=1`` is ignored: the blob is stored as ever, with no nudge."""
    response = wake_put(client, mailbox)

    assert response.status_code == 201
    assert row_count(db_path) == 1
    assert nudge_rows(db_path) == []


def test_without_a_key_a_bad_wake_is_still_refused(
    client: TestClient, db_path: Path, mailbox: str
) -> None:
    """The query is checked whether or not push is on, so bugs show early."""
    response = wake_put(client, mailbox, wake="true")

    assert response.status_code == 400
    assert response.json() == {"error": "invalid_wake"}
    assert row_count(db_path) == 0
