"""Tests for core Pydantic models."""

from reconcile_bot.core.models import Collaborator, Organization


def test_collaborator_defaults() -> None:
    """Unspecified fields on ``Collaborator`` use sensible defaults."""
    collab = Collaborator(discord_id=1, name="Alice")
    assert collab.mission_statement is None
    assert collab.organization_ids == []
    assert isinstance(collab.id, str)


def test_organization_defaults() -> None:
    """Unspecified fields on ``Organization`` use sensible defaults."""
    org = Organization(guild_id=123, name="Guild")
    assert org.mission_statement is None
    assert isinstance(org.id, str)
