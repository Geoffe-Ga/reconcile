"""Data models for Reconcile's core entities.

The models are implemented using :mod:`pydantic` so that they provide
runtime validation and convenient serialisation to and from dictionaries.
Only a couple of fields are defined for now; more can be added as the
project evolves.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, Field


class Collaborator(BaseModel):
    """Represents an individual participating in Reconcile.

    Attributes
    ----------
    id:
        Internal unique identifier for the collaborator. Defaults to a
        random UUID4 string.
    discord_id:
        The Discord user ID for cross-platform identity mapping.
    name:
        Display name of the collaborator.
    mission_statement:
        Optional mission statement provided during onboarding.
    organization_ids:
        A list of organisation identifiers the collaborator is affiliated
        with.

    """

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    discord_id: int
    name: str
    mission_statement: str | None = None
    organization_ids: list[str] = Field(default_factory=list)


class Organization(BaseModel):
    """Represents a Discord guild participating in Reconcile."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    guild_id: int
    name: str
    mission_statement: str | None = None
