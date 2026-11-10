"""Types for the part of py-vapid the relay uses (py-vapid ships none).

Only ``Vapid02``'s constructor and ``sign``, as py-vapid 1.9.6 defines them
(requirements.txt pins it). Bump these with the pin.
"""

from collections.abc import Mapping

from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePrivateKey

class Vapid02:
    """RFC 8292 VAPID signer."""

    def __init__(
        self,
        private_key: EllipticCurvePrivateKey | None = None,
        conf: Mapping[str, object] | None = None,
    ) -> None:
        """Wrap ``private_key``."""

    def sign(
        self, claims: Mapping[str, object], crypto_key: str | None = None
    ) -> dict[str, str]:
        """Return ``{"Authorization": "vapid t=<jwt>,k=<public key>"}``."""
