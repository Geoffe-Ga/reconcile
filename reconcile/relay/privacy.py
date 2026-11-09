"""The outermost ASGI layer: forget who is connecting before anything runs.

The relay must never learn a client address (ADR-0001, ADR-0019). This
middleware wraps the whole app, so it runs before routing, error handling and
any FastAPI machinery. It edits the scope the server handed over in place, so
even the server's own reference (an access logger, were one ever switched on)
sees no client. Uvicorn's ``--no-proxy-headers`` keeps the server itself from
reading ``X-Forwarded-For``; this layer is the second line.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import MutableMapping

    from starlette.types import ASGIApp, Receive, Scope, Send

FORWARDING_HEADERS = frozenset(
    {
        b"x-forwarded-for",
        b"forwarded",
        b"x-real-ip",
        b"x-forwarded-host",
        b"x-forwarded-proto",
    }
)


def forget_client(scope: MutableMapping[str, Any]) -> None:
    """Drop the client address and every forwarding header from ``scope``."""
    scope["client"] = None
    scope["headers"] = [
        (name, value)
        for name, value in scope.get("headers", ())
        if name.lower() not in FORWARDING_HEADERS
    ]


class PrivacyMiddleware:
    """Pure ASGI middleware that forgets the client of every connection."""

    def __init__(self, app: ASGIApp) -> None:
        """Wrap ``app``."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Forget the client of an HTTP or WebSocket scope, then pass it on."""
        if scope["type"] != "lifespan":
            forget_client(scope)
        await self.app(scope, receive, send)
