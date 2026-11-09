"""The relay learns no client address: not in a route, a file or its output.

Canaries use the documentation ranges (RFC 5737, RFC 3849), so a match can
only come from these tests.
"""

from __future__ import annotations

import asyncio
import http.client
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from fastapi import FastAPI, Request
from opentelemetry import metrics, trace
from starlette.testclient import TestClient

from reconcile.relay.privacy import FORWARDING_HEADERS, PrivacyMiddleware
from tests.relay.helpers import (
    OCTET_STREAM,
    api_of,
    blob,
    mailbox_id,
    put,
    sqlite_files,
)
from tests.relay.subprocess_probe import PROBE_PATH, ROUTE_VIEW, SERVER_VIEW

if TYPE_CHECKING:
    from collections.abc import Iterator, MutableMapping

    from starlette.types import ASGIApp

ROOT = Path(__file__).resolve().parents[2]
RELAY_SH = ROOT / "scripts" / "relay.sh"
BASH = shutil.which("bash") or "bash"

CANARY = "203.0.113.7"
CANARY_HEADERS = {
    "x-forwarded-for": CANARY,
    "forwarded": f"for={CANARY};proto=https",
    "x-real-ip": CANARY,
    "x-forwarded-host": f"{CANARY}.example",
    "x-forwarded-proto": "https",
}
CLIENT_ADDRESSES = ["198.51.100.23", "192.0.2.44", "2001:db8::7"]


def _probe(app: ASGIApp) -> None:
    """Add a test-only route that reports what a route can see."""

    async def probe(request: Request) -> dict[str, Any]:
        """Return the client and header names this route was handed."""
        return {
            "client": request.scope["client"],
            "headers": [name.decode() for name, _ in request.scope["headers"]],
        }

    api_of(app).add_api_route(PROBE_PATH, probe)


def _leaks(haystack: bytes, needles: list[str]) -> list[str]:
    """The needles found in ``haystack``."""
    return [needle for needle in needles if needle.encode() in haystack]


# --- The middleware on its own ---------------------------------------------


def _run(app: ASGIApp, scope: dict[str, Any]) -> None:
    """Call ``app`` with ``scope`` and no messages."""

    async def receive() -> dict[str, Any]:
        """There is nothing to receive."""
        return {"type": "http.disconnect"}

    async def send(message: MutableMapping[str, Any]) -> None:
        """Discard whatever is sent."""

    async def run() -> None:
        """Make the one call."""
        await app(scope, receive, send)

    asyncio.run(run())


def _recorder() -> tuple[ASGIApp, list[dict[str, Any]]]:
    """An inner app that records the scope object it was handed."""
    seen: list[dict[str, Any]] = []

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        """Keep the scope for the test to inspect."""
        seen.append(scope)

    return inner, seen


@pytest.mark.parametrize("kind", ["http", "websocket"])
def test_middleware_forgets_the_client_in_place(kind: str) -> None:
    """The scope itself loses its client and forwarding headers, and keeps the rest."""
    inner, seen = _recorder()
    headers = [
        (b"host", b"relay.example"),
        *[(name.encode(), value.encode()) for name, value in CANARY_HEADERS.items()],
        (b"X-Forwarded-For", CANARY.encode()),
        (b"content-type", b"application/octet-stream"),
    ]
    scope: dict[str, Any] = {
        "type": kind,
        "client": ("198.51.100.23", 50000),
        "headers": headers,
    }

    _run(PrivacyMiddleware(inner), scope)

    assert seen == [scope]
    assert seen[0] is scope
    assert scope["client"] is None
    assert scope["headers"] == [
        (b"host", b"relay.example"),
        (b"content-type", b"application/octet-stream"),
    ]


def test_middleware_leaves_lifespan_alone() -> None:
    """Lifespan events carry no client, so they pass through untouched."""
    inner, seen = _recorder()
    scope: dict[str, Any] = {"type": "lifespan", "asgi": {"version": "3.0"}}

    _run(PrivacyMiddleware(inner), scope)

    assert seen == [{"type": "lifespan", "asgi": {"version": "3.0"}}]


def test_forwarding_headers_are_exactly_the_five() -> None:
    """The middleware drops exactly the headers a proxy uses to name the client."""
    assert {
        b"x-forwarded-for",
        b"forwarded",
        b"x-real-ip",
        b"x-forwarded-host",
        b"x-forwarded-proto",
    } == FORWARDING_HEADERS


# --- In process ------------------------------------------------------------


def test_a_route_sees_no_client_address(app: ASGIApp) -> None:
    """A test-only probe route sees ``scope["client"]`` as None."""
    _probe(app)
    with TestClient(app, client=("198.51.100.23", 41000)) as client:
        seen = client.get(PROBE_PATH, headers=CANARY_HEADERS).json()

    assert seen["client"] is None
    assert not set(seen["headers"]) & set(CANARY_HEADERS)
    assert CANARY not in json.dumps(seen)


def test_distinct_clients_leave_no_address_in_files_or_output(
    app: ASGIApp,
    db_path: Path,
    capfd: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Requests from several addresses, with canaries, leave no address behind."""
    caplog.set_level(logging.DEBUG)
    needles = [CANARY, *CLIENT_ADDRESSES]
    for address in CLIENT_ADDRESSES:
        client = TestClient(app, client=(address, 41000))
        mailbox = mailbox_id()
        assert put(client, mailbox, blob(), headers=CANARY_HEADERS).status_code == 201
        page = client.get(f"/v1/mailbox/{mailbox}", headers=CANARY_HEADERS)
        assert page.status_code == 200
        assert not _leaks(page.content, needles)
    live = sqlite_files(db_path)
    out, err = capfd.readouterr()
    logged = "\n".join(record.getMessage() for record in caplog.records)

    assert {"relay.db", "relay.db-wal", "relay.db-shm"} <= set(live)
    for name, data in live.items():
        assert not _leaks(data, needles), name
    assert not _leaks((out + err + logged).encode(), needles)


class _Recording:
    """Telemetry providers that note when FastAPI asks them for anything."""

    def __init__(self) -> None:
        """Start with nothing asked."""
        self.asked: list[str] = []
        recorder = self

        class Tracers(trace.TracerProvider):
            """Hands out no-op tracers, noting each request."""

            def get_tracer(self, *args: Any, **kwargs: Any) -> trace.Tracer:
                """Note the request."""
                recorder.asked.append("tracer")
                return trace.NoOpTracer()

        class Meters(metrics.MeterProvider):
            """Hands out no-op meters, noting each request."""

            def get_meter(self, name: str, *args: Any, **kwargs: Any) -> metrics.Meter:
                """Note the request."""
                recorder.asked.append("meter")
                return metrics.NoOpMeter(name)

        self.tracers = Tracers()
        self.meters = Meters()


@pytest.fixture
def telemetry(monkeypatch: pytest.MonkeyPatch) -> Iterator[_Recording]:
    """Configure global OpenTelemetry providers that record any use."""
    recording = _Recording()
    monkeypatch.setattr(trace, "get_tracer_provider", lambda: recording.tracers)
    monkeypatch.setattr(metrics, "get_meter_provider", lambda: recording.meters)
    yield recording


def test_fastapi_telemetry_stays_off_even_when_a_provider_is_configured(
    app: ASGIApp, telemetry: _Recording
) -> None:
    """FastAPI's built-in OpenTelemetry never sees a request.

    Its spans would carry the path, so the mailbox id, and the timing.
    """
    control = FastAPI()
    control.add_api_route("/ping", lambda: {"ok": True})
    with TestClient(control) as client:
        client.get("/ping")
    assert telemetry.asked, "the recording providers should catch a default app"
    telemetry.asked.clear()

    with TestClient(app) as client:
        mailbox = mailbox_id()
        put(client, mailbox, blob())
        client.get(f"/v1/mailbox/{mailbox}")
        client.get("/v1/health")

    assert telemetry.asked == []


# --- scripts/relay.sh as a subprocess --------------------------------------


def _free_port() -> int:
    """A TCP port on 127.0.0.1 that nothing is listening on right now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _request(
    port: int,
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    """Make one plain HTTP request to the relay on ``port``."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return (
            response.status,
            {name.lower(): value for name, value in response.getheaders()},
            response.read(),
        )
    finally:
        connection.close()


def _wait_until_healthy(port: int, process: subprocess.Popen[bytes]) -> None:
    """Poll ``/v1/health`` until the relay answers, or fail if it exits."""
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        assert process.poll() is None, "relay.sh exited before it was healthy"
        try:
            status, _, _ = _request(port, "GET", "/v1/health")
        except OSError:
            time.sleep(0.1)
            continue
        assert status == 200
        return
    pytest.fail("relay.sh never became healthy")


def _relay_env(tmp_path: Path, port: int, db_path: Path) -> dict[str, str]:
    """Environment for relay.sh: our interpreter, the probe, a temp database."""
    hook = tmp_path / "hook"
    hook.mkdir()
    (hook / "sitecustomize.py").write_text(
        '"""Install the test probe."""\n\n'
        "from tests.relay.subprocess_probe import install\n\n"
        "install()\n"
    )
    return {
        **os.environ,
        "PATH": os.pathsep.join([str(Path(sys.executable).parent), os.environ["PATH"]]),
        "PYTHONPATH": os.pathsep.join([str(hook), str(ROOT)]),
        "RECONCILE_RELAY_PORT": str(port),
        "RECONCILE_RELAY_DB": str(db_path),
    }


def _exchange(port: int, mailbox: str) -> list[tuple[int, dict[str, str], bytes]]:
    """PUT, GET and probe the relay, each carrying every canary header."""
    upload = {**CANARY_HEADERS, **OCTET_STREAM}
    return [
        _request(
            port,
            "PUT",
            f"/v1/mailbox/{mailbox}?ttl_days=2",
            body=blob(),
            headers=upload,
        ),
        _request(port, "GET", f"/v1/mailbox/{mailbox}?after=0", headers=CANARY_HEADERS),
        _request(port, "GET", PROBE_PATH, headers=CANARY_HEADERS),
    ]


def _views(stdout: bytes) -> list[dict[str, Any]]:
    """The probe's JSON lines from the relay's stdout."""
    lines = [line for line in stdout.splitlines() if line.startswith(b"{")]
    return [json.loads(line) for line in lines]


@dataclass(frozen=True)
class RelayRun:
    """What one run of scripts/relay.sh answered, wrote and printed."""

    mailbox: str
    data_dir: Path
    responses: list[tuple[int, dict[str, str], bytes]]
    files: dict[str, bytes]
    output: bytes
    views: list[dict[str, Any]]


@pytest.fixture(scope="module")
def relay_run(tmp_path_factory: pytest.TempPathFactory) -> RelayRun:
    """Run relay.sh once on a free port, exchange canary requests, then stop it.

    The files are read twice: live, while the relay holds its WAL and shared
    memory open, and again after it shuts down and folds them away.
    """
    tmp_path = tmp_path_factory.mktemp("relay-sh")
    port = _free_port()
    db_path = tmp_path / "data" / "relay.db"
    mailbox = mailbox_id()
    process = subprocess.Popen(
        [BASH, str(RELAY_SH)],
        cwd=ROOT,
        env=_relay_env(tmp_path, port, db_path),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        _wait_until_healthy(port, process)
        responses = _exchange(port, mailbox)
        live = sqlite_files(db_path)
    finally:
        process.terminate()
        stdout, stderr = process.communicate(timeout=30)
    after = {
        f"{name} (after shutdown)": data for name, data in sqlite_files(db_path).items()
    }
    return RelayRun(
        mailbox=mailbox,
        data_dir=db_path.parent,
        responses=responses,
        files={**live, **after},
        output=stdout + stderr,
        views=_views(stdout),
    )


def test_relay_sh_serves_the_mailbox(relay_run: RelayRun) -> None:
    """The relay.sh run really stored and returned the blob, with no Server header."""
    (put_status, _, _), (get_status, _, page), _ = relay_run.responses

    assert (put_status, get_status) == (201, 200)
    assert len(json.loads(page)["records"]) == 1
    assert all("server" not in headers for _, headers, _ in relay_run.responses)


def test_relay_sh_route_sees_no_client(relay_run: RelayRun) -> None:
    """Inside the real server, a route sees no client and no forwarding header.

    Removing the privacy middleware fails this.
    """
    _, _, (_, _, probed) = relay_run.responses
    (route_view,) = [v for v in relay_run.views if v["view"] == ROUTE_VIEW]

    assert json.loads(probed) == {"client": None}
    assert route_view["client"] is None
    assert not {name for name, _ in route_view["headers"]} & set(CANARY_HEADERS)


def test_relay_sh_output_has_no_address_and_no_request(relay_run: RelayRun) -> None:
    """stdout and stderr carry no canary, no mailbox id and no request line.

    The server view prints the client address Uvicorn resolved, so removing
    ``--no-proxy-headers`` fails this with the canary; removing
    ``--no-access-log`` fails it with the mailbox id and path.
    """
    assert any(view["view"] == SERVER_VIEW for view in relay_run.views)
    assert not _leaks(relay_run.output, [CANARY, relay_run.mailbox, "/v1/mailbox"])


def test_relay_sh_files_hold_no_address(relay_run: RelayRun) -> None:
    """relay.db, -wal and -shm hold neither the canary nor the TCP peer."""
    assert {"relay.db", "relay.db-wal", "relay.db-shm"} <= set(relay_run.files)
    for name, data in relay_run.files.items():
        assert not _leaks(data, [CANARY, "127.0.0.1"]), name


def test_relay_sh_keeps_its_files_private(relay_run: RelayRun) -> None:
    """relay.sh's umask leaves the data directory and database owner-only."""
    for path in (relay_run.data_dir, relay_run.data_dir / "relay.db"):
        assert path.stat().st_mode & 0o077 == 0, path
