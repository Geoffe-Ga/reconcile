"""A probe that test_privacy installs into the ``scripts/relay.sh`` subprocess.

The test puts a ``sitecustomize.py`` on the subprocess's ``PYTHONPATH`` that
calls :func:`install`. It plays the worst case: code that prints everything it
is handed, so the test can search the output for the addresses it sent.

- The server view wraps the whole app and prints the client address Uvicorn
  hands over. With ``--no-proxy-headers`` that is the TCP peer; without it,
  Uvicorn substitutes the address from ``X-Forwarded-For``.
- The route view is a test-only route that prints the client and headers a
  route can see. With the privacy middleware in place there are none to see.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, Request

if TYPE_CHECKING:
    from starlette.types import ASGIApp, Receive, Scope, Send

    from reconcile.relay.app import Clock
    from reconcile.relay.push import PushSender
    from reconcile.relay.settings import Settings

PROBE_PATH = "/test-only/probe"
SERVER_VIEW = "server-view"
ROUTE_VIEW = "route-view"


def _emit(view: str, **seen: Any) -> None:
    """Print one JSON line saying what this view saw."""
    print(json.dumps({"view": view, **seen}), flush=True)


def _text(headers: Any) -> list[list[str]]:
    """Header pairs as text, for printing."""
    return [
        [name.decode("latin-1"), value.decode("latin-1")] for name, value in headers
    ]


class ServerView:
    """Outermost wrapper: prints the client address the server resolved."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap ``app``."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Print the server-resolved client of each HTTP request, then pass it on."""
        if scope["type"] == "http":
            _emit(SERVER_VIEW, client=scope.get("client"))
        await self.app(scope, receive, send)


async def probe(request: Request) -> dict[str, Any]:
    """Print and return what a route can see of the caller."""
    client = request.scope.get("client")
    _emit(ROUTE_VIEW, client=client, headers=_text(request.scope["headers"]))
    return {"client": client}


def install() -> None:
    """Wrap ``create_app`` so the relay Uvicorn builds carries both views."""
    from reconcile.relay import app as relay_app
    from reconcile.relay.privacy import PrivacyMiddleware

    original = relay_app.create_app

    def create_app(
        settings: Settings | None = None,
        clock: Clock | None = None,
        sender: PushSender | None = None,
    ) -> ASGIApp:
        """Build the real relay, add the probe route, and wrap the result."""
        app = original(settings, clock, sender)
        api = app.app if isinstance(app, PrivacyMiddleware) else app
        assert isinstance(api, FastAPI)
        api.add_api_route(PROBE_PATH, probe)
        return ServerView(app)

    relay_app.create_app = create_app
