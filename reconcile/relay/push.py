"""Content-free Web Push: wake a device with an empty push (ADR-0012, #89).

A device registers its push endpoint under a group's mailbox. A blob PUT
with ``wake=1``, or a nudge a device scheduled ("closing soon"), marks the
mailbox due in a relay minute. Every ``TICK_SECONDS`` the relay takes the due
mailboxes and sends each of their live endpoints one empty POST (RFC 8030),
signed with the relay's VAPID key (RFC 8292). The device wakes, syncs and
decrypts on its own; the push itself says only "something new".

What this adds to the relay's view, and nothing more (ADR-0019, ADR-0075 §2):

- **Endpoints**, for up to 30 days. An endpoint is a capability URL at
  Apple, Google, Mozilla or Microsoft, tied to one device, so the database
  shows which mailboxes share a phone. Only the browsers' push services are
  accepted, which also keeps the relay from being aimed at any other host.
- **Due minutes**, which show which blobs mattered and when votes close.

Every push has the same body (none) and the same headers, apart from the
VAPID signature. Nothing here logs, and a failed send is dropped without a
trace or a retry.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import re
from dataclasses import dataclass
from http.cookiejar import CookieJar, DefaultCookiePolicy
from typing import TYPE_CHECKING, Protocol

import httpx2
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02

from reconcile.relay.settings import VAPID_KEY_ENV, VAPID_SUBJECT_ENV, SettingsError
from reconcile.relay.store import BlobStore, day_of, minute_of

if TYPE_CHECKING:
    from collections.abc import Callable

    from reconcile.relay.settings import Settings

    # Returns the current time in unix seconds, like time.time.
    Clock = Callable[[], float]

TICK_SECONDS: float = 15
SUB_TTL_DAYS = 30  # a re-PUT refreshes it; the blob day rule rounds it up
MAX_SUBS = 100  # endpoints per mailbox; the 101st evicts the soonest expiry
MAX_NUDGES = 50  # pending nudges per mailbox
NUDGE_HORIZON = 43_200  # minutes: a nudge is at most 30 days ahead
MAX_ENDPOINT_BYTES = 1024

# The browsers' push services. Anything else is refused, and never called.
PUSH_HOSTS = frozenset(
    {"fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"}
)
PUSH_HOST_SUFFIXES = (".push.apple.com", ".notify.windows.com")

# Lower-case DNS labels, an optional :443, then a path of URL characters. No
# userinfo, fragment, backslash, space or non-ASCII, so no URL parser can
# read a different host out of a string that passes.
_ENDPOINT = re.compile(
    r"https://(?P<host>[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::443)?"
    r"(?:/[A-Za-z0-9._~!$&'()*+,;=:%/?-]*)?"
)
_LABEL = r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
# Two or more labels, the last starting with a letter, so no IPv4 address.
_DOMAIN = re.compile(rf"(?:{_LABEL}\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?", re.IGNORECASE)
_MAIL_LOCAL_PART = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+")

# A push service's answer that the subscription is gone. 201 or 202 is
# success; anything else keeps the row, with no retry.
GONE = frozenset({404, 410})
# One Topic for every group, so a push service keeps one queued wake per
# device, and a day's TTL, so a phone that was off still hears of it.
PUSH_HEADERS = {"TTL": "86400", "Urgency": "normal", "Topic": "reconcile"}
JWT_SECONDS = 12 * 3600  # RFC 8292 allows at most 24 hours
CONNECT_SECONDS = 5.0
TOTAL_SECONDS = 10.0
# Loggers that would write each push's URL, or its host, if switched on.
HTTP_LOGGERS = ("httpx2", "httpcore2")


class EndpointRejectedError(ValueError):
    """An endpoint that isn't on one of the browsers' push services."""


@dataclass(frozen=True)
class VapidKey:
    """The relay's VAPID identity.

    Attributes:
        signer: py-vapid's RFC 8292 signer over the private key.
        subject: The ``sub`` claim, an ``https:`` or ``mailto:`` URI.
        public_key: The uncompressed public point, unpadded base64url
            (87 characters), as ``GET /v1/push/key`` serves it.
    """

    signer: Vapid02
    subject: str
    public_key: str


class PushSender(Protocol):
    """Sends one empty push. ``create_app`` takes a fake one in tests."""

    async def send(self, endpoint: str) -> int:
        """POST nothing to ``endpoint`` and return the HTTP status."""

    async def aclose(self) -> None:
        """Release the connections, at shutdown."""


def endpoint_origin(endpoint: str) -> str | None:
    """Return ``https://<host>`` for an acceptable endpoint, else ``None``.

    Acceptable: at most 1,024 bytes of printable ASCII, ``https``, no
    userinfo or fragment, port absent or 443, and a host on ``PUSH_HOSTS`` or
    under one of ``PUSH_HOST_SUFFIXES``. An IP literal is never on the list.
    """
    if len(endpoint) > MAX_ENDPOINT_BYTES or not endpoint.isascii():
        return None
    match = _ENDPOINT.fullmatch(endpoint)
    if match is None:
        return None
    host = match["host"]
    if host not in PUSH_HOSTS and not host.endswith(PUSH_HOST_SUFFIXES):
        return None
    return f"https://{host}"


def check_subject(subject: str) -> None:
    """Refuse a ``sub`` that push services would reject, or that names a machine.

    Accepted: ``https://<domain>`` or ``mailto:<local>@<domain>``, where the
    domain isn't ``localhost``, under it, or an IP address.

    Raises:
        SettingsError: for anything else, including an empty value.
    """
    if subject.startswith("https://"):
        host = subject.removeprefix("https://")
    elif subject.startswith("mailto:"):
        local, _, host = subject.removeprefix("mailto:").rpartition("@")
        if _MAIL_LOCAL_PART.fullmatch(local) is None:
            raise SettingsError(VAPID_SUBJECT_ENV)
    else:
        raise SettingsError(VAPID_SUBJECT_ENV)
    if _DOMAIN.fullmatch(host) is None or host.lower().rsplit(".", 1)[1] == "localhost":
        raise SettingsError(VAPID_SUBJECT_ENV)


def load_vapid(settings: Settings) -> VapidKey | None:
    """Load the VAPID key the settings name, or ``None`` when push is off.

    Raises:
        SettingsError: the subject fails ``check_subject``, or the key file
            is missing, unreadable, encrypted or not a P-256 private key.
            The relay never makes a key itself: deploy.sh does, once.
    """
    if settings.vapid_key is None:
        return None
    check_subject(settings.vapid_subject)
    try:
        key = serialization.load_pem_private_key(
            settings.vapid_key.read_bytes(), password=None
        )
    except (OSError, ValueError, TypeError, UnsupportedAlgorithm):
        raise SettingsError(VAPID_KEY_ENV) from None
    if not (
        isinstance(key, ec.EllipticCurvePrivateKey)
        and isinstance(key.curve, ec.SECP256R1)
    ):
        raise SettingsError(VAPID_KEY_ENV)
    point = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return VapidKey(
        signer=Vapid02(private_key=key),
        subject=settings.vapid_subject,
        public_key=base64.urlsafe_b64encode(point).rstrip(b"=").decode("ascii"),
    )


class WebPushSender:
    """Sends empty, VAPID-signed pushes over one ``httpx2.AsyncClient``.

    The client follows no redirect, reads no environment (no proxy, netrc or
    certificate override), keeps no cookie (its jar allows no domain), so
    no push service can link two pushes by one, sends no header but its own
    and never reads a response body. Each send gets 5 s to connect and 10 s in
    all. Its loggers are silenced, since they would write the URL.
    """

    def __init__(
        self,
        vapid: VapidKey,
        clock: Clock,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        """Sign with ``vapid`` at ``clock``'s time; tests pass a ``transport``."""
        for name in HTTP_LOGGERS:
            logger = logging.getLogger(name)
            logger.setLevel(logging.CRITICAL + 1)
            logger.propagate = False
        self.vapid = vapid
        self.clock = clock
        self.client = httpx2.AsyncClient(
            transport=transport,
            follow_redirects=False,
            timeout=httpx2.Timeout(TOTAL_SECONDS, connect=CONNECT_SECONDS),
            trust_env=False,
            cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=())),
        )
        self.client.headers.clear()  # no User-Agent, Accept or the like

    async def send(self, endpoint: str) -> int:
        """POST nothing to ``endpoint`` and return the status, never following it.

        Raises:
            EndpointRejectedError: ``endpoint`` isn't on a push service.
            TimeoutError: no answer within ``TOTAL_SECONDS``.
        """
        origin = endpoint_origin(endpoint)
        if origin is None:
            raise EndpointRejectedError
        claims = {
            "aud": origin,
            "exp": int(self.clock()) + JWT_SECONDS,
            "sub": self.vapid.subject,
        }
        headers = {**PUSH_HEADERS, **self.vapid.signer.sign(claims)}
        async with (
            asyncio.timeout(TOTAL_SECONDS),
            self.client.stream("POST", endpoint, headers=headers, content=b"") as reply,
        ):
            return reply.status_code

    async def aclose(self) -> None:
        """Close the client's connections."""
        await self.client.aclose()


async def run_due(store: BlobStore, sender: PushSender, now: float) -> None:
    """Take the nudges due at ``now`` and push each of their live endpoints once.

    The nudges are deleted before anything is sent: a push is attempted at
    most once. 201 and 202 succeed; 404 and 410 mean the subscription is
    gone, so its rows go too; anything else, an exception included, keeps
    the row with no retry. Nothing is logged.
    """
    mailboxes = store.take_due_nudges(minute_of(now))
    endpoints = store.live_endpoints(mailboxes, today=day_of(now))
    statuses = await asyncio.gather(
        *(_attempt(sender, endpoint) for endpoint in endpoints)
    )
    for endpoint, status in zip(endpoints, statuses, strict=True):
        if status in GONE:
            store.forget_endpoint(endpoint)


async def _attempt(sender: PushSender, endpoint: str) -> int | None:
    """Send one push; ``None`` if it raised. The exception is dropped unread."""
    try:
        return await sender.send(endpoint)
    except Exception:
        return None


async def tick(store: BlobStore, sender: PushSender, clock: Clock) -> None:
    """Run ``run_due`` every ``TICK_SECONDS`` until cancelled, whatever it raises."""
    while True:
        await asyncio.sleep(TICK_SECONDS)
        with contextlib.suppress(Exception):
            await run_due(store, sender, clock())
