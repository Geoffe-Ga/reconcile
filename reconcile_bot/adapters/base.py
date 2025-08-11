"""Base adapter interface for platform specific implementations."""

from __future__ import annotations

from abc import ABC, abstractmethod


class Adapter(ABC):
    """Abstract adapter for communication platforms."""

    @abstractmethod
    async def send_message(self, channel_id: str, content: str) -> None:
        """Send ``content`` to the specified ``channel_id``."""

    @abstractmethod
    async def create_text_channel(self, guild_id: str, name: str) -> str:
        """Create a text channel and return its identifier."""
