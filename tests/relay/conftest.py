"""Fixtures for the relay tests: a fake clock, settings, an app and a client.

The ``push_*`` fixtures build the same relay with push on: a VAPID key made
for the test, the subject deploy.sh would set, and a fake sender. The
``shelf_*`` fixtures build it with the shelf on: a steward key made for the
test (#484).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from starlette.testclient import TestClient

from reconcile.relay import push
from reconcile.relay.app import create_app
from reconcile.relay.settings import Settings
from tests.relay.helpers import (
    SUBJECT,
    FakeClock,
    FakeSender,
    ShelfSigner,
    store_of,
    write_vapid_key,
)

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


@pytest.fixture
def vapid_key(tmp_path: Path) -> Path:
    """A fresh P-256 VAPID key in this test's temp directory."""
    path = tmp_path / "vapid.pem"
    write_vapid_key(path)
    return path


@pytest.fixture
def push_settings(db_path: Path, vapid_key: Path) -> Settings:
    """Settings with push on: the test's key and deploy.sh's kind of subject."""
    return Settings(db_path=db_path, vapid_key=vapid_key, vapid_subject=SUBJECT)


@pytest.fixture
def sender() -> FakeSender:
    """A sender that records pushes instead of making them."""
    return FakeSender()


@pytest.fixture
def push_app(
    push_settings: Settings,
    clock: FakeClock,
    sender: FakeSender,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[ASGIApp]:
    """A relay with push on. Its own tick waits an hour, so tests drive it."""
    monkeypatch.setattr(push, "TICK_SECONDS", 3600)
    relay = create_app(push_settings, clock, sender=sender)
    yield relay
    store_of(relay).close()


@pytest.fixture
def push_client(push_app: ASGIApp) -> Iterator[TestClient]:
    """A test client for the push-on relay, with lifespan startup and shutdown."""
    with TestClient(push_app) as test_client:
        yield test_client


@pytest.fixture
def steward() -> ShelfSigner:
    """The steward's key for this test, made at run time."""
    return ShelfSigner.fresh()


@pytest.fixture
def shelf_settings(db_path: Path, steward: ShelfSigner) -> Settings:
    """Settings with the shelf on: the steward's public key is set."""
    return Settings(db_path=db_path, shelf_steward_key=steward.address)


@pytest.fixture
def shelf_app(shelf_settings: Settings, clock: FakeClock) -> Iterator[ASGIApp]:
    """A relay with the shelf on, on the fake clock."""
    relay = create_app(shelf_settings, clock)
    yield relay
    store_of(relay).close()


@pytest.fixture
def shelf_client(shelf_app: ASGIApp) -> Iterator[TestClient]:
    """A test client for the shelf-on relay."""
    with TestClient(shelf_app) as test_client:
        yield test_client


@pytest.fixture
def door() -> ShelfSigner:
    """A listed door's ``sign`` key, made at run time."""
    return ShelfSigner.fresh()
