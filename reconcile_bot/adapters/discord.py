"""Discord adapter implementing the :class:`~reconcile_bot.adapters.base.Adapter`.

The adapter is intentionally small and only supports the features required by
the unit tests. It uses :mod:`httpx` to communicate with Discord's HTTP API
which keeps the implementation dependency light while remaining fully
asynchronous.
"""

from __future__ import annotations

from typing import Any

import httpx

from .base import Adapter


class DiscordAdapter(Adapter):
    """Adapter that sends requests directly to the Discord HTTP API."""

    api_base = "https://discord.com/api"

    def __init__(self, token: str, client: httpx.AsyncClient | None = None) -> None:
        """Store authentication ``token`` and optional HTTP ``client``."""
        self.token = token
        self.client = client or httpx.AsyncClient()

    # ------------------------------------------------------------------
    async def send_message(self, channel_id: str, content: str) -> None:
        """Send a message to a channel.

        Parameters
        ----------
        channel_id:
            Identifier of the Discord channel.
        content:
            Message body to send.

        """
        url = f"{self.api_base}/channels/{channel_id}/messages"
        headers = {"Authorization": f"Bot {self.token}"}
        payload = {"content": content}
        response = await self.client.post(url, json=payload, headers=headers)
        response.raise_for_status()

    async def create_text_channel(self, guild_id: str, name: str) -> str:
        """Create a text channel within a guild.

        Returns the identifier of the newly created channel.
        """
        url = f"{self.api_base}/guilds/{guild_id}/channels"
        headers = {"Authorization": f"Bot {self.token}"}
        payload = {"name": name, "type": 0}
        response = await self.client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        data: dict[str, Any] = response.json()
        return str(data["id"])

    async def close(self) -> None:
        """Close the underlying :class:`httpx.AsyncClient`."""
        await self.client.aclose()
