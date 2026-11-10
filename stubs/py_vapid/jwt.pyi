"""Types for py-vapid's JWT decoder, which the relay's tests verify with."""

from typing import Any

def decode(token: str, key: str) -> dict[str, Any]:
    """Verify ``token`` under the base64url public ``key``; return its claims."""
