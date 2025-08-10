import os
from dataclasses import dataclass

@dataclass(frozen=True)
class Settings:
    token: str
    data_path: str = "reconcile_data.json"
    # Set to True to sync commands per guild for faster propagation
    sync_per_guild: bool = True

def load_settings() -> Settings:
    token = os.getenv("DISCORD_BOT_TOKEN", "").strip()
    return Settings(token=token or "")