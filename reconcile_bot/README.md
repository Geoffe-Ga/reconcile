# Reconcile Discord Bot

A modular, JSON-backed Discord bot that lets groups collaborate on documents via proposals and votes.

## Features

• Slash commands: `/create_group`, `/join_group`, `/list_groups`, `/create_document`, `/list_documents`, `/view_document`,
  `/recommend`, `/my_groups`, `/reconcile`, `/reconcile_status`, `/reconcile_cancel`
• Documents created via `/create_document` are previewed in `#reconcile-docs`
• Proposals: open a modal to submit content changes and vote Accept/Reject with buttons
• Simple merge rule: a proposal merges when it has more accepts than rejects and at least a simple majority of current group members have accepted
• JSON persistence so state survives restarts

## Setup

1) Python 3.10+ recommended.
2) Install discord.py: `pip install discord.py`
3) Create a Discord bot in the Developer Portal, invite it with the `applications.commands` scope and permissions to send messages.
4) Export your token:
   - macOS/Linux: `export DISCORD_BOT_TOKEN='YOUR_TOKEN'`
   - Windows PowerShell: `$Env:DISCORD_BOT_TOKEN='YOUR_TOKEN'`
5) Run the bot:
   ```bash
   python -m reconcile_bot.main
   ```

The bot uses slash commands. In a new guild, commands can take up to ~1 hour to propagate globally; re-inviting or changing the bot can speed this up. You can also modify the code to sync per guild if desired.

## Developer Notes

• Code is structured into `data` (models and store), `ui` (modals and views), `commands` (slash commands), and the `bot` class.
• To reset data, delete `reconcile_data.json`.
• Unit tests cover the data layer: run `pytest -q` from the project root.
