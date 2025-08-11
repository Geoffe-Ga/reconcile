"""Core package for Reconcile.

This module exposes the main data models and storage layer so that
consumers of the package can simply import them from ``reconcile_bot``.

The project is intentionally small at this stage; additional modules will
build upon these foundations in future iterations.
"""

from .core.models import Collaborator, Organization
from .core.storage import JSONStorage

__all__ = ["Collaborator", "Organization", "JSONStorage"]
