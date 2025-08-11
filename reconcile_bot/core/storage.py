"""Simple JSON-backed storage for Reconcile data models."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path

from .models import Collaborator, Organization


class JSONStorage:
    """Persist :class:`Collaborator` and :class:`Organization` data.

    The storage is intentionally lightweight. Data is persisted to a single
    JSON file on every mutation which keeps the implementation simple while
    providing durability across process restarts.
    """

    def __init__(self, path: Path) -> None:
        """Initialise storage using JSON file at ``path``."""
        self.path = path
        self._collaborators: dict[str, Collaborator] = {}
        self._organizations: dict[str, Organization] = {}
        if path.exists():
            self._load()
        else:
            self._save()

    # ------------------------------------------------------------------
    # Internal helpers
    def _load(self) -> None:
        data = json.loads(self.path.read_text())
        self._collaborators = {
            item["id"]: Collaborator(**item) for item in data.get("collaborators", [])
        }
        self._organizations = {
            item["id"]: Organization(**item) for item in data.get("organizations", [])
        }

    def _save(self) -> None:
        data = {
            "collaborators": [c.model_dump() for c in self._collaborators.values()],
            "organizations": [o.model_dump() for o in self._organizations.values()],
        }
        self.path.write_text(json.dumps(data, indent=2))

    # ------------------------------------------------------------------
    # Collaborator operations
    def add_collaborator(self, collaborator: Collaborator) -> None:
        """Persist a new ``collaborator`` to storage."""
        self._collaborators[collaborator.id] = collaborator
        self._save()

    def get_collaborator_by_discord(self, discord_id: int) -> Collaborator | None:
        """Retrieve a collaborator by their Discord user ID."""
        return next(
            (c for c in self._collaborators.values() if c.discord_id == discord_id),
            None,
        )

    def all_collaborators(self) -> Iterable[Collaborator]:
        """Return an iterable of all stored collaborators."""
        return self._collaborators.values()

    # ------------------------------------------------------------------
    # Organization operations
    def add_organization(self, organization: Organization) -> None:
        """Persist a new ``organization`` to storage."""
        self._organizations[organization.id] = organization
        self._save()

    def get_organization_by_guild(self, guild_id: int) -> Organization | None:
        """Look up an organization by its Discord guild ID."""
        return next(
            (o for o in self._organizations.values() if o.guild_id == guild_id),
            None,
        )

    def all_organizations(self) -> Iterable[Organization]:
        """Return an iterable of all stored organizations."""
        return self._organizations.values()
