from __future__ import annotations
import asyncio
import discord
from discord.ext import commands
from .logging_config import setup_logging

class ReconcileBot(commands.Bot):
    def __init__(self, **kwargs):
        intents = kwargs.pop("intents", None) or discord.Intents.default()
        # We use slash commands and components; message content intent not needed
        intents.message_content = False
        super().__init__(command_prefix=kwargs.pop("command_prefix", "!"), intents=intents)
        self.log = setup_logging()

    async def setup_hook(self) -> None:
        # Could register persistent views here if needed
        pass

    async def on_ready(self) -> None:
        await self.change_presence(activity=discord.Game(name="/create_group • /join_group • /view_document"))
        self.log.info("Logged in as %s (%s)", self.user, self.user.id if self.user else "?")

from discord.ext import tasks
import datetime
from datetime import UTC

class _StoreHolder:
    store: ReconcileStore | None = None

STORE_HOLDER = _StoreHolder()

def attach_store(store: ReconcileStore):
    STORE_HOLDER.store = store

async def _update_reconcile_messages(bot: ReconcileBot):
    store = STORE_HOLDER.store
    if not store: return
    from .ui.views import reconcile_embed, VoteView
    for rec in store.list_open_reconciles():
        # reminders at 24h and 1h
        remaining = rec.close_ts - datetime.datetime.now(tz=UTC).timestamp()

# reminders
if 60*59 < remaining <= 60*61 and not getattr(rec, "reminded_1", False):  # ~1h
    ch = bot.get_channel(rec.channel_id)
    if ch and rec.thread_id:
        thread = await ch.fetch_channel(rec.thread_id)
        await thread.send("⏰ Final reminder: 1 hour left to vote.")
    rec.reminded_1 = True
    store.save()
if 60*60*23 < remaining <= 60*60*25 and not getattr(rec, "reminded_24", False):  # ~24h
    ch = bot.get_channel(rec.channel_id)
    if ch and rec.thread_id:
        thread = await ch.fetch_channel(rec.thread_id)
        await thread.send("⏰ Reminder: 24 hours left to vote.")
    rec.reminded_24 = True
    store.save()
if remaining < 0 and not rec.closed:

            # close and post result
            ch = bot.get_channel(rec.channel_id)
            if ch and rec.thread_id:
                thread = await ch.fetch_channel(rec.thread_id)
                e = reconcile_embed(store, rec.reconcile_id)
                state = "PASSED" if rec.passes() else "FAILED"
                await thread.send(f"Vote closed: {state}")
                await thread.send(embed=e)
            store.close_reconcile(rec.reconcile_id)
            continue
        # refresh tally embed
        if rec.thread_id and rec.message_id:
            ch = bot.get_channel(rec.channel_id)
            if not ch:
                continue
            try:
                thread = await ch.fetch_channel(rec.thread_id)
                msg = await thread.fetch_message(rec.message_id)
                await msg.edit(embed=reconcile_embed(store, rec.reconcile_id), view=VoteView(store, rec.reconcile_id, rec.a_side, rec.b_side))
            except Exception:
                pass

class ReconcileBot(commands.Bot):
    background_task: tasks.Loop

    async def setup_hook(self) -> None:
        # Register persistent views if any in future; start background loops
        self.background_task = tasks.Loop(_update_reconcile_messages, seconds=60.0, count=None, reconnect=True, kwargs={"bot": self})
        self.background_task.start()
        await super().setup_hook()

    async def on_ready(self) -> None:
        await self.change_presence(activity=discord.Game(name="Reconcile"))
        self.log.info("Logged in as %s (%s)", self.user, self.user.id if self.user else "?")
