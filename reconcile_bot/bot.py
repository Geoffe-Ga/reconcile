"""Discord bot implementation for the reconciliation workflow.

This module previously contained a large block of code that had lost all
indentation.  Python therefore raised an ``IndentationError`` whenever the
module was imported which is why ``python -m reconcile_bot.main`` failed.  The
tests never imported this module so the issue slipped through.  The file has
been rewritten with proper structure and a small test now compiles it to catch
similar problems in the future.
"""

from __future__ import annotations

import datetime

import discord
from discord.ext import commands, tasks
import datetime
from datetime import UTC
from .logging_config import setup_logging
from .data.store import ReconcileStore


class ReconcileBot(commands.Bot):
    """Small ``discord.py`` based bot used for running reconciliations."""

    background_task: tasks.Loop | None

    def __init__(self, **kwargs) -> None:  # pragma: no cover - trivial
        intents = kwargs.pop("intents", None) or discord.Intents.default()
        # We use slash commands and components; message content intent not
        # needed.
        intents.message_content = False
        super().__init__(command_prefix=kwargs.pop("command_prefix", "!"), intents=intents)
        self.log = setup_logging()
        self.background_task = None

    async def setup_hook(self) -> None:
        """Register background tasks when the bot starts."""

        # Periodically update open reconciliation messages.
        # ``tasks.Loop`` expects several positional arguments which previously
        # caused a ``TypeError`` when the bot started.  Using the
        # ``tasks.loop`` decorator creates the ``Loop`` instance correctly.
        self.background_task = tasks.loop(seconds=60.0, reconnect=True)(
            _update_reconcile_messages
        )
        self.background_task.start(self)
        await super().setup_hook()

    async def on_ready(self) -> None:  # pragma: no cover - requires discord
        await self.change_presence(activity=discord.Game(name="Reconcile"))
        self.log.info("Logged in as %s (%s)", self.user, self.user.id if self.user else "?")
        

class _StoreHolder:
    """Simple indirection so the store can be attached after creation."""

    store: ReconcileStore | None = None


STORE_HOLDER = _StoreHolder()


def attach_store(store: ReconcileStore) -> None:
    STORE_HOLDER.store = store


async def _update_reconcile_messages(bot: ReconcileBot) -> None:
    """Background task for refreshing and closing reconcile messages."""

    store = STORE_HOLDER.store
    if not store:
        return

    from .ui.views import VoteView, reconcile_embed

    for rec in store.list_open_reconciles():
        # reminders at 24h and 1h
        remaining = rec.close_ts - datetime.datetime.now(tz=UTC).timestamp()

        # ------------------------------------------------------------------
        # Reminder messages at ~24h and ~1h before closing
        # ------------------------------------------------------------------
        if 60 * 59 < remaining <= 60 * 61 and not getattr(rec, "reminded_1", False):
            ch = bot.get_channel(rec.channel_id)
            if ch and rec.thread_id:
                thread = await ch.fetch_channel(rec.thread_id)
                await thread.send("⏰ Final reminder: 1 hour left to vote.")
            rec.reminded_1 = True
            store.save()

        if 60 * 60 * 23 < remaining <= 60 * 60 * 25 and not getattr(rec, "reminded_24", False):
            ch = bot.get_channel(rec.channel_id)
            if ch and rec.thread_id:
                thread = await ch.fetch_channel(rec.thread_id)
                await thread.send("⏰ Reminder: 24 hours left to vote.")
            rec.reminded_24 = True
            store.save()

        # ------------------------------------------------------------------
        # Close reconciles that have expired
        # ------------------------------------------------------------------
        if remaining < 0 and not rec.closed:
            ch = bot.get_channel(rec.channel_id)
            if ch and rec.thread_id:
                thread = await ch.fetch_channel(rec.thread_id)
                e = reconcile_embed(store, rec.reconcile_id)
                state = "PASSED" if rec.passes() else "FAILED"
                await thread.send(f"Vote closed: {state}")
                await thread.send(embed=e)
            store.close_reconcile(rec.reconcile_id)
            continue

        # ------------------------------------------------------------------
        # Otherwise refresh the tally message if we have one
        # ------------------------------------------------------------------
        if rec.thread_id and rec.message_id:
            ch = bot.get_channel(rec.channel_id)
            if not ch:
                continue
            try:
                thread = await ch.fetch_channel(rec.thread_id)
                msg = await thread.fetch_message(rec.message_id)
                await msg.edit(
                    embed=reconcile_embed(store, rec.reconcile_id),
                    view=VoteView(store, rec.reconcile_id, rec.a_side, rec.b_side),
                )
            except Exception:  # pragma: no cover - best effort
                pass


__all__ = [
    "ReconcileBot",
    "attach_store",
    "_update_reconcile_messages",
]

