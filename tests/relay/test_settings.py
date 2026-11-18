"""Relay settings come from the environment, and the database path is required."""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from reconcile.relay.settings import Settings, SettingsError


def test_the_database_path_is_required() -> None:
    """There is no default database outside scripts/relay.sh."""
    with pytest.raises(SettingsError, match="RECONCILE_RELAY_DB"):
        Settings.from_env({})


def test_an_empty_database_path_is_refused() -> None:
    """An empty value is as good as a missing one."""
    with pytest.raises(SettingsError, match="RECONCILE_RELAY_DB"):
        Settings.from_env({"RECONCILE_RELAY_DB": ""})


def test_the_size_cap_defaults_to_one_gibibyte() -> None:
    """Without RECONCILE_RELAY_MAX_DB_BYTES the cap is 1 GiB."""
    settings = Settings.from_env({"RECONCILE_RELAY_DB": "relay.db"})

    assert settings == Settings(db_path=Path("relay.db"), max_db_bytes=1_073_741_824)


def test_the_size_cap_can_be_set() -> None:
    """RECONCILE_RELAY_MAX_DB_BYTES sets the cap in bytes."""
    settings = Settings.from_env(
        {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_MAX_DB_BYTES": "4096"}
    )

    assert settings.max_db_bytes == 4096


def test_the_mailbox_cap_defaults_to_sixty_four_mebibytes() -> None:
    """Without RECONCILE_RELAY_MAX_MAILBOX_BYTES each mailbox holds 64 MiB (#141)."""
    settings = Settings.from_env({"RECONCILE_RELAY_DB": "relay.db"})

    assert settings.max_mailbox_bytes == 67_108_864
    assert Settings(db_path=Path("relay.db")).max_mailbox_bytes == 67_108_864


def test_the_mailbox_cap_can_be_set() -> None:
    """RECONCILE_RELAY_MAX_MAILBOX_BYTES sets the cap in bytes, apart from the other."""
    settings = Settings.from_env(
        {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_MAX_MAILBOX_BYTES": "8192"}
    )

    assert settings.max_mailbox_bytes == 8192
    assert settings.max_db_bytes == 1_073_741_824


@pytest.mark.parametrize(
    "variable", ["RECONCILE_RELAY_MAX_DB_BYTES", "RECONCILE_RELAY_MAX_MAILBOX_BYTES"]
)
@pytest.mark.parametrize("value", ["", "0", "-1", "1.5", "1e9", "lots", "٣"])
def test_a_bad_size_cap_is_refused(variable: str, value: str) -> None:
    """Each cap must be a positive whole number of bytes, and the error names it."""
    with pytest.raises(SettingsError, match=f"^{variable} must be a positive"):
        Settings.from_env({"RECONCILE_RELAY_DB": "relay.db", variable: value})


def test_from_env_reads_the_process_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no mapping given, settings come from ``os.environ``."""
    monkeypatch.setenv("RECONCILE_RELAY_DB", "/var/lib/reconcile/relay.db")
    monkeypatch.delenv("RECONCILE_RELAY_MAX_DB_BYTES", raising=False)

    assert Settings.from_env().db_path == Path("/var/lib/reconcile/relay.db")


def test_settings_are_frozen() -> None:
    """No setting can change after the app reads them."""
    settings = Settings(db_path=Path("relay.db"))

    for field in dataclasses.fields(settings):
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(settings, field.name, None)


def test_push_is_off_without_a_vapid_key() -> None:
    """With no RECONCILE_RELAY_VAPID_KEY there is no key and no subject."""
    settings = Settings.from_env({"RECONCILE_RELAY_DB": "relay.db"})

    assert settings.vapid_key is None
    assert settings.vapid_subject == ""


def test_an_empty_vapid_key_leaves_push_off() -> None:
    """An empty key path is as good as none: push stays off."""
    settings = Settings.from_env(
        {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_VAPID_KEY": ""}
    )

    assert settings.vapid_key is None


def test_the_vapid_key_and_subject_are_read() -> None:
    """The key is a path; the subject is kept exactly as given."""
    settings = Settings.from_env(
        {
            "RECONCILE_RELAY_DB": "relay.db",
            "RECONCILE_RELAY_VAPID_KEY": "/var/lib/reconcile/vapid.pem",
            "RECONCILE_RELAY_VAPID_SUBJECT": "https://relay.example.org",
        }
    )

    assert settings.vapid_key == Path("/var/lib/reconcile/vapid.pem")
    assert settings.vapid_subject == "https://relay.example.org"


def test_the_shelf_is_off_without_a_steward_key() -> None:
    """With no RECONCILE_RELAY_SHELF_STEWARD_KEY the shelf routes are off (#484)."""
    settings = Settings.from_env({"RECONCILE_RELAY_DB": "relay.db"})

    assert settings.shelf_steward_key is None
    assert Settings(db_path=Path("relay.db")).shelf_steward_key is None


def test_an_empty_steward_key_leaves_the_shelf_off() -> None:
    """An empty key is as good as none."""
    settings = Settings.from_env(
        {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_SHELF_STEWARD_KEY": ""}
    )

    assert settings.shelf_steward_key is None


def test_the_steward_key_is_read() -> None:
    """The steward's Ed25519 public key, in unpadded base64url, is kept as given."""
    key = "Ag" + "A" * 40 + "E"
    settings = Settings.from_env(
        {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_SHELF_STEWARD_KEY": key}
    )

    assert settings.shelf_steward_key == key


@pytest.mark.parametrize(
    "value",
    ["A" * 42, "A" * 44, "A" * 42 + "B", "A" * 42 + "+", "A" * 42 + "=", " " * 43],
)
def test_a_bad_steward_key_is_refused(value: str) -> None:
    """Anything but a canonical 32-byte key stops the relay from starting."""
    with pytest.raises(
        SettingsError, match=r"^RECONCILE_RELAY_SHELF_STEWARD_KEY must be an Ed25519"
    ):
        Settings.from_env(
            {
                "RECONCILE_RELAY_DB": "relay.db",
                "RECONCILE_RELAY_SHELF_STEWARD_KEY": value,
            }
        )


def test_the_shelf_cap_defaults_to_sixty_four_mebibytes() -> None:
    """Without RECONCILE_RELAY_SHELF_MAX_BYTES the shelf holds 64 MiB."""
    settings = Settings.from_env({"RECONCILE_RELAY_DB": "relay.db"})

    assert settings.max_shelf_bytes == 67_108_864
    assert Settings(db_path=Path("relay.db")).max_shelf_bytes == 67_108_864


def test_the_shelf_cap_can_be_set() -> None:
    """RECONCILE_RELAY_SHELF_MAX_BYTES sets it in bytes."""
    settings = Settings.from_env(
        {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_SHELF_MAX_BYTES": "2048"}
    )

    assert settings.max_shelf_bytes == 2048


@pytest.mark.parametrize("value", ["", "0", "-1", "lots"])
def test_a_bad_shelf_cap_is_refused(value: str) -> None:
    """The shelf cap must be a positive whole number of bytes."""
    with pytest.raises(
        SettingsError, match=r"^RECONCILE_RELAY_SHELF_MAX_BYTES must be a positive"
    ):
        Settings.from_env(
            {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_SHELF_MAX_BYTES": value}
        )


@pytest.mark.parametrize("value", [None, "", "held"])
def test_the_shelf_mode_is_held(value: str | None) -> None:
    """Unset, empty or ``held``: held mode, the only one built (#488, §4.2)."""
    env = {"RECONCILE_RELAY_DB": "relay.db"}
    if value is not None:
        env["RECONCILE_RELAY_SHELF_MODE"] = value

    assert Settings.from_env(env).shelf_mode == "held"
    assert Settings(db_path=Path("relay.db")).shelf_mode == "held"


@pytest.mark.parametrize("value", ["open", "HELD", " held", "live"])
def test_any_other_shelf_mode_is_refused(value: str) -> None:
    """Open mode is deferred (listed-doors.md §9), so naming it stops the relay."""
    with pytest.raises(
        SettingsError, match=r"^RECONCILE_RELAY_SHELF_MODE must be held"
    ):
        Settings.from_env(
            {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_SHELF_MODE": value}
        )
