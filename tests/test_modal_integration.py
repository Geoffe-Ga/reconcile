import asyncio
import sys
import types


def test_document_modal_posts_preview(monkeypatch, tmp_path):
    # Minimal discord stubs
    class Modal:
        def __init__(self, *args, **kwargs):
            self.children = []
        def add_item(self, item):
            self.children.append(item)
        def __init_subclass__(cls, **kwargs):
            pass
    class TextInput:
        def __init__(self, *args, **kwargs):
            self.value = ""
    class TextStyle:
        long = 1
    class Embed:
        def __init__(self, *args, **kwargs):
            pass
        def set_footer(self, *args, **kwargs):
            pass
    ui = types.SimpleNamespace(Modal=Modal, TextInput=TextInput)
    discord_stub = types.SimpleNamespace(
        ui=ui,
        TextStyle=TextStyle,
        Embed=Embed,
        utils=types.SimpleNamespace(get=lambda *a, **k: None),
    )
    monkeypatch.setitem(sys.modules, "discord", discord_stub)
    monkeypatch.setitem(sys.modules, "discord.ui", ui)
    monkeypatch.setitem(sys.modules, "discord.utils", discord_stub.utils)

    # Stub DocumentView import to avoid heavy discord dependency
    class DummyDocumentView:
        def __init__(self, *args, **kwargs):
            pass
    views_module = types.SimpleNamespace(DocumentView=DummyDocumentView)
    monkeypatch.setitem(sys.modules, "reconcile_bot.ui.views", views_module)

    from reconcile_bot.data.store import ReconcileStore
    from reconcile_bot.ui.modals import DocumentModal

    # Set up store and group
    store = ReconcileStore(path=str(tmp_path / "data.json"))
    store.create_group("g1", "desc", [], creator_id=1)

    # Mock ensure_channels to return our dummy channels
    class DummyChannel:
        def __init__(self, name):
            self.name = name
            self.sent = []
            self.mention = f"#{name}"
        async def send(self, *args, **kwargs):
            self.sent.append((args, kwargs))
    docs_ch = DummyChannel("reconcile-docs")
    votes_ch = DummyChannel("reconcile-votes")
    async def ensure_channels_mock(guild):
        return docs_ch, votes_ch
    monkeypatch.setattr("reconcile_bot.ui.modals.ensure_channels", ensure_channels_mock)

    # Build modal and interaction
    modal = DocumentModal(store, "g1", "title", [])
    modal.content_input.value = "content"

    class Response:
        def __init__(self):
            self.messages = []
        async def send_message(self, content, **kwargs):
            self.messages.append((content, kwargs))
    interaction = types.SimpleNamespace(guild=object(), response=Response(), user=types.SimpleNamespace(id=1))

    asyncio.run(modal.on_submit(interaction))

    assert len(docs_ch.sent) == 1
