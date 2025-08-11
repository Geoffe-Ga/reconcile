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
import sys
import types


def test_setup_hook_uses_tasks_loop(monkeypatch) -> None:
    # ------------------------------------------------------------------
    # Create minimal ``discord`` package
    # ------------------------------------------------------------------
    discord = types.ModuleType("discord")

    class Intents:
        message_content: bool = False

        @staticmethod
        def default() -> Intents:
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
            self.guilds = []

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
    monkeypatch.delitem(sys.modules, "reconcile_bot.commands.utils", raising=False)
    monkeypatch.delitem(sys.modules, "reconcile_bot.bot", raising=False)

    # Import after stubbing modules to ensure ``reconcile_bot.bot`` uses them
    from reconcile_bot.bot import ReconcileBot

    bot = ReconcileBot()

    # ``setup_hook`` should complete without raising a ``TypeError`` or
    # ``AttributeError`` (which would happen if ``tasks.Loop`` were used).
    asyncio.run(bot.setup_hook())


def test_setup_hook_creates_channels(monkeypatch) -> None:
    # ------------------------------------------------------------------
    # Create minimal ``discord`` package with channel utilities
    # ------------------------------------------------------------------
    discord = types.ModuleType("discord")

    class Intents:
        message_content: bool = False

        @staticmethod
        def default() -> Intents:  # pragma: no cover - simple stub
            return Intents()

    discord.Intents = Intents

    def utils_get(seq, **attrs):
        for item in seq:
            if all(getattr(item, k, None) == v for k, v in attrs.items()):
                return item
        return None

    discord.utils = types.SimpleNamespace(get=utils_get)

    ext = types.ModuleType("discord.ext")
    commands = types.ModuleType("discord.ext.commands")
    tasks = types.ModuleType("discord.ext.tasks")

    class Bot:  # pragma: no cover - trivial container for required API
        def __init__(self, *args, **kwargs) -> None:
            self.guilds = []

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
    monkeypatch.setitem(sys.modules, "discord.utils", discord.utils)
    monkeypatch.setitem(sys.modules, "discord.ext", ext)
    monkeypatch.setitem(sys.modules, "discord.ext.commands", commands)
    monkeypatch.setitem(sys.modules, "discord.ext.tasks", tasks)
    monkeypatch.delitem(sys.modules, "reconcile_bot.commands.utils", raising=False)
    monkeypatch.delitem(sys.modules, "reconcile_bot.bot", raising=False)

    # Import after stubbing modules
    from reconcile_bot.bot import ReconcileBot

    class Channel:
        def __init__(self, name, cid):
            self.name = name
            self.id = cid

    class Guild:
        def __init__(self):
            self.text_channels = []
            self._next = 1

        async def create_text_channel(self, name):
            ch = Channel(name, self._next)
            self._next += 1
            self.text_channels.append(ch)
            return ch

    guild = Guild()

    bot = ReconcileBot()
    bot.guilds = [guild]

    asyncio.run(bot.setup_hook())

    names = sorted(ch.name for ch in guild.text_channels)
    assert names == ["reconcile-docs", "reconcile-votes"]
