from __future__ import annotations

import asyncio

from .bot import ReconcileBot, attach_store
from .commands.register import register_commands
from .config import load_settings
from .data.store import ReconcileStore
from .logging_config import setup_logging


def main() -> int:
    log = setup_logging()
    settings = load_settings()
    if not settings.token:
        log.error(
            "DISCORD_BOT_TOKEN is not set. "
            "Export it in your environment before running."
        )
        return 2
    store = ReconcileStore(path=settings.data_path)
    bot = ReconcileBot()
    attach_store(store)
    register_commands(bot, store)

    async def runner():
        try:
            async with bot:
                await bot.start(settings.token)
        except KeyboardInterrupt:
            log.info("Shutting down...")
        return 0

    return asyncio.run(runner())


if __name__ == "__main__":
    raise SystemExit(main())
