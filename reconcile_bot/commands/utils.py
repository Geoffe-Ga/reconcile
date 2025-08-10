from __future__ import annotations

import discord


async def ensure_channels(
    guild: discord.Guild,
) -> tuple[discord.TextChannel, discord.TextChannel]:
    """
    Ensure the reconciliation channels exist in ``guild``.
    Returns a tuple of ``(docs_channel, votes_channel)``.
    """

    docs = discord.utils.get(guild.text_channels, name="reconcile-docs")
    votes = discord.utils.get(guild.text_channels, name="reconcile-votes")
    if docs is None:
        docs = await guild.create_text_channel("reconcile-docs")
    if votes is None:
        votes = await guild.create_text_channel("reconcile-votes")
    return docs, votes
