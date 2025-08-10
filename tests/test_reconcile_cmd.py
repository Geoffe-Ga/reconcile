import sys
import types
import asyncio


def setup_discord_stubs():
    """Install minimal stubs for the ``discord`` package and related modules."""
    discord = types.ModuleType("discord")
    discord_ext = types.ModuleType("discord.ext")
    discord_ext.commands = types.SimpleNamespace(Bot=object)
    sys.modules["discord"] = discord
    sys.modules["discord.ext"] = discord_ext

    class Choice:
        def __init__(self, name, value):
            self.name = name
            self.value = value

    def describe(**kwargs):
        def deco(f):
            return f
        return deco

    def choices(**kwargs):
        def deco(f):
            return f
        return deco

    discord.app_commands = types.SimpleNamespace(
        Choice=Choice, describe=describe, choices=choices
    )

    class View:
        def __init__(self, timeout=None):
            self.timeout = timeout
            self.children = []

        def add_item(self, item):
            self.children.append(item)

    class SelectOption:
        def __init__(self, label, value):
            self.label = label
            self.value = value

    class Select:
        def __init__(self, placeholder=None, options=None):
            self.placeholder = placeholder
            self.options = options or []
            self.values = []
            self.callback = None

    class Button:
        def __init__(self, label, style):
            self.label = label
            self.style = style
            self.callback = None

    class ButtonStyle:
        primary = 1
        success = 2

    discord.ui = types.SimpleNamespace(
        View=View,
        Select=Select,
        Button=Button,
        SelectOption=SelectOption,
        ButtonStyle=ButtonStyle,
    )

    class ChannelType:
        public_thread = 1

    discord.ChannelType = ChannelType
    discord.Embed = object
    discord.utils = types.SimpleNamespace(get=lambda seq, **kwargs: None)
    discord.ext = types.SimpleNamespace(commands=types.SimpleNamespace(Bot=object))

    # Stub out UI modules used in register.py
    modals_mod = types.ModuleType("reconcile_bot.ui.modals")
    modals_mod.DocumentModal = type("DocumentModal", (object,), {})
    views_mod = types.ModuleType("reconcile_bot.ui.views")
    views_mod.DocumentView = type("DocumentView", (object,), {})
    views_mod.VoteView = type("VoteView", (object,), {})
    views_mod.reconcile_embed = lambda store, rid: None
    sys.modules["reconcile_bot.ui.modals"] = modals_mod
    sys.modules["reconcile_bot.ui.views"] = views_mod


def make_interaction():
    class Response:
        def __init__(self):
            self.deferred = False
            self.content = None

        async def defer(self, ephemeral=False):
            self.deferred = True

        async def edit_original_response(self, content=None, view=None):
            self.content = content

    class Interaction:
        def __init__(self):
            self.response = Response()
            self.guild = types.SimpleNamespace(id=1)

        async def edit_original_response(self, content=None, view=None):
            self.response.content = content

    return Interaction()


def test_reconcile_cmd_choices():
    setup_discord_stubs()

    from reconcile_bot.commands import register

    class DummyTree:
        def command(self, *args, **kwargs):
            def deco(func):
                setattr(self, func.__name__, func)
                return func
            return deco

    class DummyBot:
        def __init__(self):
            self.tree = DummyTree()

    bot = DummyBot()
    store = object()
    register.register_commands(bot, store)
    cmd = bot.tree.reconcile_cmd

    async def fake_start(interaction, mode, your_group, target_group, store, guild_id):
        return ("ok", None)

    def make_cell(value):
        return (lambda: value).__closure__[0]

    import types as _types

    new_closure = list(cmd.__closure__)
    new_closure[0] = make_cell(fake_start)
    cmd = _types.FunctionType(
        cmd.__code__, cmd.__globals__, cmd.__name__, cmd.__defaults__, tuple(new_closure)
    )
    bot.tree.reconcile_cmd = cmd

    Choice = sys.modules["discord"].app_commands.Choice

    # group vs group
    inter1 = make_interaction()
    asyncio.run(bot.tree.reconcile_cmd(inter1, Choice("gvg", "group_vs_group"), "A", "B"))
    assert inter1.response.deferred is True
    assert inter1.response.content == "ok"

    # solo to group
    inter2 = make_interaction()
    asyncio.run(bot.tree.reconcile_cmd(inter2, Choice("stg", "solo_to_group"), None, "B"))
    assert inter2.response.deferred is True
    assert inter2.response.content == "ok"
