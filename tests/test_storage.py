"""Tests for the ``JSONStorage`` persistence layer."""

from pathlib import Path

from reconcile_bot.core.models import Collaborator, Organization
from reconcile_bot.core.storage import JSONStorage


def test_add_and_get_collaborator(tmp_path: Path) -> None:
    """Collaborators can be saved and retrieved."""
    storage = JSONStorage(tmp_path / "data.json")
    collab = Collaborator(discord_id=42, name="Bob")
    storage.add_collaborator(collab)

    loaded = storage.get_collaborator_by_discord(42)
    assert loaded is not None
    assert loaded.discord_id == 42


def test_add_and_get_organization(tmp_path: Path) -> None:
    """Organizations can be saved and retrieved."""
    storage = JSONStorage(tmp_path / "data.json")
    org = Organization(guild_id=999, name="Test Guild")
    storage.add_organization(org)

    loaded = storage.get_organization_by_guild(999)
    assert loaded is not None
    assert loaded.guild_id == 999


def test_all_collaborators(tmp_path: Path) -> None:
    """Iterating returns all saved collaborators."""
    storage = JSONStorage(tmp_path / "data.json")
    storage.add_collaborator(Collaborator(discord_id=1, name="Alice"))
    storage.add_collaborator(Collaborator(discord_id=2, name="Bob"))

    ids = {c.discord_id for c in storage.all_collaborators()}
    assert ids == {1, 2}


def test_get_collaborator_missing(tmp_path: Path) -> None:
    """Missing collaborator lookups yield ``None``."""
    storage = JSONStorage(tmp_path / "data.json")
    assert storage.get_collaborator_by_discord(123) is None


def test_all_organizations(tmp_path: Path) -> None:
    """Iterating returns all saved organizations."""
    storage = JSONStorage(tmp_path / "data.json")
    storage.add_organization(Organization(guild_id=1, name="Org1"))
    storage.add_organization(Organization(guild_id=2, name="Org2"))

    ids = {o.guild_id for o in storage.all_organizations()}
    assert ids == {1, 2}


def test_get_organization_missing(tmp_path: Path) -> None:
    """Missing organization lookups yield ``None``."""
    storage = JSONStorage(tmp_path / "data.json")
    assert storage.get_organization_by_guild(123) is None


def test_persistence_across_instances(tmp_path: Path) -> None:
    """Data survives across multiple storage instances."""
    path = tmp_path / "data.json"
    storage = JSONStorage(path)
    storage.add_collaborator(Collaborator(discord_id=77, name="Eve"))
    storage.add_organization(Organization(guild_id=88, name="Guild"))

    assert path.exists()

    new_storage = JSONStorage(path)
    assert new_storage.get_collaborator_by_discord(77) is not None
    assert new_storage.get_organization_by_guild(88) is not None
