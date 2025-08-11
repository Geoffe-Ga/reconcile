import sys
import types

import pytest

# --- Discord stub -----------------------------------------------------


@pytest.fixture()
def discord_stub(monkeypatch):
    discord = types.ModuleType("discord")

    # ui submodule
    ui = types.ModuleType("discord.ui")

    class View:
        def __init__(self, timeout=None):
            self.timeout = timeout

    class Button:
        def __init__(self, label=None, style=None):
            self.label = label
            self.style = style

    def button(**kwargs):
        def decorator(func):
            return func

        return decorator

    class Modal:
        def __init_subclass__(cls, **kwargs):
            pass

        def __init__(self, *args, **kwargs):
            pass

        def add_item(self, item):
            pass

    class TextInput:
        def __init__(self, *args, **kwargs):
            pass

    ui.View = View
    ui.Button = Button
    ui.button = button
    ui.Modal = Modal
    ui.TextInput = TextInput

    discord.ui = ui
    monkeypatch.setitem(sys.modules, "discord", discord)
    monkeypatch.setitem(sys.modules, "discord.ui", ui)

    class Color:
        @staticmethod
        def red():
            return 0

        @staticmethod
        def blurple():
            return 0

    class Embed:
        def __init__(self, *args, **kwargs):
            pass

        def add_field(self, *args, **kwargs):
            pass

        def set_footer(self, *args, **kwargs):
            pass

    discord.Color = Color
    discord.Embed = Embed
    discord.TextStyle = types.SimpleNamespace(long=0)
    discord.ButtonStyle = types.SimpleNamespace(
        secondary=1, primary=2, danger=3, success=4
    )
    return discord


@pytest.fixture()
def document_components(discord_stub):
    for mod in [
        "reconcile_bot.commands.utils",
        "reconcile_bot.ui.views",
        "reconcile_bot.ui.modals",
    ]:
        sys.modules.pop(mod, None)
    import reconcile_bot.ui.modals as modals
    import reconcile_bot.ui.views as views
    from reconcile_bot.data.store import ReconcileStore

    yield views.DocumentView, modals.ProposalModal, ReconcileStore
    for mod in [
        "reconcile_bot.commands.utils",
        "reconcile_bot.ui.views",
        "reconcile_bot.ui.modals",
    ]:
        sys.modules.pop(mod, None)


# --- Interaction fakes ------------------------------------------------


class FakeResponse:
    def __init__(self):
        self.deferred = False
        self.sent_message = None
        self.modal = None
        self.ephemeral = None

    async def send_message(self, content, *, ephemeral=False):
        self.sent_message = (content, ephemeral)

    async def send_modal(self, modal):
        self.modal = modal

    async def defer(self, *, ephemeral=False):
        self.deferred = True
        self.ephemeral = ephemeral


class FakeFollowup:
    def __init__(self):
        self.messages = []

    async def send(self, content, *, ephemeral=False):
        self.messages.append((content, ephemeral))


class FakeInteraction:
    def __init__(self, user_id=1):
        self.user = types.SimpleNamespace(id=user_id)
        self.response = FakeResponse()
        self.followup = FakeFollowup()


# --- Tests -------------------------------------------------------------


def test_view_full_returns_ephemeral(document_components, tmp_path):
    DocumentView, _, ReconcileStore = document_components
    store = ReconcileStore(str(tmp_path / "data.json"))
    store.create_group("G", "d", [], 1)
    doc_id = store.create_document("G", "T", [], "content")
    view = DocumentView(store, "G", doc_id)
    inter = FakeInteraction()
    import asyncio

    asyncio.run(view.view_full(None, inter))
    assert inter.response.deferred
    assert inter.followup.messages[0][1] is True


def test_propose_returns_modal(document_components, tmp_path):
    DocumentView, ProposalModal, ReconcileStore = document_components
    store = ReconcileStore(str(tmp_path / "data.json"))
    store.create_group("G", "d", [], 1)
    doc_id = store.create_document("G", "T", [], "content")
    view = DocumentView(store, "G", doc_id)
    inter = FakeInteraction()
    import asyncio

    asyncio.run(view.propose(None, inter))
    assert isinstance(inter.response.modal, ProposalModal)


def test_view_props_returns_ephemeral(document_components, tmp_path):
    DocumentView, _, ReconcileStore = document_components
    store = ReconcileStore(str(tmp_path / "data.json"))
    store.create_group("G", "d", [], 1)
    doc_id = store.create_document("G", "T", [], "content")
    store.add_proposal("G", doc_id, 1, "new")
    view = DocumentView(store, "G", doc_id)
    inter = FakeInteraction()
    import asyncio

    asyncio.run(view.view_props(None, inter))
    assert inter.response.deferred
    assert inter.followup.messages[0][1] is True
