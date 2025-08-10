"""Tests for :func:`ReconcileBot.setup_hook`.

This test provides minimal stand-ins for the ``discord`` package so that the
bot can be instantiated and its ``setup_hook`` executed.  The previous
implementation attempted to construct :class:`discord.ext.tasks.Loop` directly
which required several positional arguments and raised a ``TypeError`` when the
bot started.  The test fails if ``tasks.loop`` is not used because our stub
module intentionally does not expose ``tasks.Loop``.
"""

from __future__ import annotations

import asyncio
import types
import sys


def test_setup_hook_uses_tasks_loop(monkeypatch) -> None:
    # ------------------------------------------------------------------
    # Create minimal ``discord`` package
    # ------------------------------------------------------------------
    discord = types.ModuleType("discord")

    class Intents:
        message_content: bool = False

        @staticmethod
        def default() -> "Intents":
            return Intents()

    discord.Intents = Intents

    class Game:
        def __init__(self, name: str) -> None:  # pragma: no cover - trivial
            self.name = name

    discord.Game = Game

    ext = types.ModuleType("discord.ext")
    commands = types.ModuleType("discord.ext.commands")
    tasks = types.ModuleType("discord.ext.tasks")

    class Bot:  # pragma: no cover - trivial container for required API
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def setup_hook(self) -> None:
            pass

        async def change_presence(self, *_, **__) -> None:
            pass

    commands.Bot = Bot

    def loop(*_args, **_kwargs):
        def decorator(func):
            class DummyLoop:
                def start(self, *a, **kw):  # pragma: no cover - trivial
                    pass

            return DummyLoop()

        return decorator

    tasks.loop = loop

    ext.commands = commands
    ext.tasks = tasks

    monkeypatch.setitem(sys.modules, "discord", discord)
    monkeypatch.setitem(sys.modules, "discord.ext", ext)
    monkeypatch.setitem(sys.modules, "discord.ext.commands", commands)
    monkeypatch.setitem(sys.modules, "discord.ext.tasks", tasks)

    # Import after stubbing modules to ensure ``reconcile_bot.bot`` uses them
    from reconcile_bot.bot import ReconcileBot

    bot = ReconcileBot()

    # ``setup_hook`` should complete without raising a ``TypeError`` or
    # ``AttributeError`` (which would happen if ``tasks.Loop`` were used).
    asyncio.run(bot.setup_hook())

