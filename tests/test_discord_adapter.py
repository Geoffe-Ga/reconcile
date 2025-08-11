"""Tests for the :mod:`reconcile_bot.adapters.discord` module."""

import asyncio
from typing import Any

import httpx

from reconcile_bot.adapters.discord import DiscordAdapter


def run(coro: Any) -> Any:
    """Run an async coroutine synchronously for tests."""
    return asyncio.get_event_loop().run_until_complete(coro)


def test_send_message_makes_correct_request() -> None:
    """Ensure ``send_message`` posts the expected payload."""
    captured: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        return httpx.Response(200, json={"id": "123"})

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    adapter = DiscordAdapter("TOKEN", client=client)

    run(adapter.send_message("chan", "hello"))

    request = captured["request"]
    assert request.headers["Authorization"] == "Bot TOKEN"
    assert request.url.path.endswith("/channels/chan/messages")


def test_create_text_channel_returns_id() -> None:
    """``create_text_channel`` should return the new channel id."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/guilds/1/channels")
        return httpx.Response(200, json={"id": "555"})

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    adapter = DiscordAdapter("TOKEN", client=client)

    channel_id = run(adapter.create_text_channel("1", "general"))
    assert channel_id == "555"

    run(adapter.close())
