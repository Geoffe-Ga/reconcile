import logging
import os

from reconcile_bot.config import load_settings
from reconcile_bot.logging_config import setup_logging


def test_load_settings(monkeypatch):
    monkeypatch.setenv("DISCORD_BOT_TOKEN", "abc123")
    s = load_settings()
    assert s.token == "abc123"
    assert s.data_path == "reconcile_data.json"

    # empty token environment
    monkeypatch.setenv("DISCORD_BOT_TOKEN", "")
    s2 = load_settings()
    assert s2.token == ""


def test_setup_logging_idempotent():
    logger1 = setup_logging(logging.DEBUG)
    logger2 = setup_logging(logging.DEBUG)
    assert logger1 is logger2
    assert logger1.handlers  # at least one handler installed
