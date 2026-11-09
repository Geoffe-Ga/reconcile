"""Fixtures for the relay tests: a fake clock, settings, an app and a client."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from starlette.testclient import TestClient

from reconcile.relay.app import create_app
from reconcile.relay.settings import Settings
from tests.relay.helpers import FakeClock, store_of

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from starlette.types import ASGIApp


@pytest.fixture
def clock() -> FakeClock:
    """A fake clock set to 2026-11-09T12:00:00Z."""
    return FakeClock()


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    """Where this test's relay keeps its SQLite file."""
    return tmp_path / "relay.db"


@pytest.fixture
def settings(db_path: Path) -> Settings:
    """Settings for a relay on this test's database, with the default size cap."""
    return Settings(db_path=db_path)


@pytest.fixture
def app(settings: Settings, clock: FakeClock) -> Iterator[ASGIApp]:
    """A relay app on the fake clock. Its store is closed after the test."""
    relay = create_app(settings, clock)
    yield relay
    store_of(relay).close()


@pytest.fixture
def client(app: ASGIApp) -> Iterator[TestClient]:
    """A test client for the relay, with lifespan startup and shutdown."""
    with TestClient(app) as test_client:
        yield test_client
