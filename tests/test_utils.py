import asyncio
import types
import sys


def test_ensure_channels_creates_missing(monkeypatch):
    # create stub for discord.utils.get
    def utils_get(seq, **attrs):
        for item in seq:
            if all(getattr(item, k, None) == v for k, v in attrs.items()):
                return item
        return None

    discord_stub = types.SimpleNamespace(utils=types.SimpleNamespace(get=utils_get))
    monkeypatch.setitem(sys.modules, "discord", discord_stub)
    monkeypatch.setitem(sys.modules, "discord.utils", discord_stub.utils)

    # Reload module to pick up stubbed discord
    import importlib
    from reconcile_bot.commands import utils as utils_mod
    importlib.reload(utils_mod)
    ensure_channels = utils_mod.ensure_channels

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

        def get_channel(self, cid):
            for c in self.text_channels:
                if c.id == cid:
                    return c

    guild = Guild()
    docs_ch, votes_ch = asyncio.run(ensure_channels(guild))
    assert docs_ch.id != votes_ch.id
    names = sorted(ch.name for ch in guild.text_channels)
    assert names == ["reconcile-docs", "reconcile-votes"]
