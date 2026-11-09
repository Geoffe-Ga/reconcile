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


@pytest.mark.parametrize("value", ["", "0", "-1", "1.5", "1e9", "lots", "٣"])
def test_a_bad_size_cap_is_refused(value: str) -> None:
    """The cap must be a positive whole number of bytes."""
    with pytest.raises(SettingsError, match="RECONCILE_RELAY_MAX_DB_BYTES"):
        Settings.from_env(
            {"RECONCILE_RELAY_DB": "relay.db", "RECONCILE_RELAY_MAX_DB_BYTES": value}
        )


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
