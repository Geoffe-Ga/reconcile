import asyncio
import sys
import types

import pytest


def stub_discord(monkeypatch):
    """Provide minimal discord package for command registration and autocomplete."""
    discord = types.ModuleType("discord")

    # Basic structures -------------------------------------------------
    class Interaction:
        def __init__(self, user_id=0, namespace=None):
            self.user = types.SimpleNamespace(id=user_id)
            self.namespace = namespace or types.SimpleNamespace()
    discord.Interaction = Interaction

    class Embed:
        def __init__(self, *args, **kwargs):
            pass
        def add_field(self, *args, **kwargs):
            pass
        def set_footer(self, *args, **kwargs):
            pass
    discord.Embed = Embed

    class SelectOption:
        def __init__(self, label: str, value: str):
            self.label = label
            self.value = value
    discord.SelectOption = SelectOption

    # UI module ---------------------------------------------------------
    ui = types.ModuleType("discord.ui")

    class View:
        def __init__(self, *args, **kwargs):
            self.children = []
        def add_item(self, item):
            self.children.append(item)
    ui.View = View

    class Select:
        def __init__(self, *_, **kwargs):
            self.options = kwargs.get("options", [])
            self.values = []
            self.callback = None
    ui.Select = Select

    class Button:
        def __init__(self, *args, **kwargs):
            pass
    ui.Button = Button

    class ButtonStyle:
        success = 1
        primary = 2
        danger = 3
        secondary = 4
    discord.ButtonStyle = ButtonStyle

    def button(**_kwargs):
        def decorator(func):
            return func
        return decorator
    ui.button = button

    class Modal:
        def __init__(self, *args, **kwargs):
            pass
        def add_item(self, *_args, **_kwargs):
            pass
        def __init_subclass__(cls, **kwargs):
            pass
    ui.Modal = Modal

    discord.ui = ui

    # utils submodule --------------------------------------------------
    def _utils_get(_seq, **_attrs):
        return None
    utils_mod = types.SimpleNamespace(get=_utils_get)
    discord.utils = utils_mod

    # app_commands module ----------------------------------------------
    app_commands = types.ModuleType("discord.app_commands")

    class Choice:
        def __init__(self, name: str, value):
            self.name = name
            self.value = value
    app_commands.Choice = Choice

    def describe(**_kwargs):
        def decorator(func):
            return func
        return decorator
    app_commands.describe = describe

    discord.app_commands = app_commands

    # Command system ----------------------------------------------------
    class Command:
        def __init__(self, callback, name: str, description: str):
            self.callback = callback
            self.name = name
            self.description = description
            self.autocomplete_callbacks = {}
        def autocomplete(self, param: str):
            def decorator(func):
                self.autocomplete_callbacks[param] = func
                return func
            return decorator

    class CommandTree:
        def __init__(self):
            self.commands = {}
        def command(self, *, name: str, description: str):
            def decorator(func):
                cmd = Command(func, name, description)
                self.commands[name] = cmd
                return cmd
            return decorator
    discord.app_commands.CommandTree = CommandTree

    ext = types.ModuleType("discord.ext")
    commands_mod = types.ModuleType("discord.ext.commands")
    class Bot:
        def __init__(self, *args, **kwargs):
            self.tree = CommandTree()
    commands_mod.Bot = Bot
    ext.commands = commands_mod
    discord.ext = ext

    monkeypatch.setitem(sys.modules, "discord", discord)
    monkeypatch.setitem(sys.modules, "discord.ext", ext)
    monkeypatch.setitem(sys.modules, "discord.ext.commands", commands_mod)
    monkeypatch.setitem(sys.modules, "discord.app_commands", app_commands)
    monkeypatch.setitem(sys.modules, "discord.utils", utils_mod)

    return discord


def make_store(tmp_path):
    from reconcile_bot.data.store import ReconcileStore
    store = ReconcileStore(path=str(tmp_path / "store.json"))
    store.create_group("alpha", "desc", [], 1)
    store.create_group("beta", "desc", [], 2)
    store.join_group("alpha", 1)
    store.create_document("alpha", "Doc1", [], "content1")
    store.create_document("alpha", "Doc2", [], "content2")
    return store


def test_autocomplete(monkeypatch, tmp_path):
    discord = stub_discord(monkeypatch)
    from reconcile_bot.commands.register import register_commands
    store = make_store(tmp_path)

    bot = discord.ext.commands.Bot()
    register_commands(bot, store)

    create_cmd = bot.tree.commands["create_document"]
    list_cmd = bot.tree.commands["list_documents"]
    view_cmd = bot.tree.commands["view_document"]

    inter = discord.Interaction(user_id=1)

    choices = asyncio.run(create_cmd.autocomplete_callbacks["group_name"](inter, ""))
    assert [c.name for c in choices] == ["alpha"]

    choices = asyncio.run(list_cmd.autocomplete_callbacks["group_name"](inter, ""))
    assert {c.name for c in choices} == {"alpha", "beta"}

    choices = asyncio.run(view_cmd.autocomplete_callbacks["group_name"](inter, ""))
    assert {c.name for c in choices} == {"alpha", "beta"}

    ns = types.SimpleNamespace(group_name="alpha")
    inter2 = discord.Interaction(user_id=1, namespace=ns)
    choices = asyncio.run(view_cmd.autocomplete_callbacks["document_id"](inter2, ""))
    assert [c.value for c in choices] == [1, 2]

    # Ensure later tests get a clean import of the utils module
    sys.modules.pop("reconcile_bot.commands.utils", None)
