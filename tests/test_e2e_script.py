"""Tests for client/scripts/e2e.sh, which runs the Playwright loop.

The tests run a copy of e2e.sh in a temp tree whose ``npm`` and ``npx`` are
stubs on PATH. Each stub logs what it was asked to run and the environment the
loop would have seen, so the tests check the script's own work (free ports for
each Playwright worker, a temp directory for the relays that is deleted
afterwards, build before test) without a browser or a relay.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess  # nosec B404 - runs our own script in a temp tree
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
E2E = ROOT / "client" / "scripts" / "e2e.sh"
BASH = shutil.which("bash") or "bash"
SEP = "\t"

# Logs one line per call: the command, its directory, the three variables the
# Playwright config reads, and whether the relays' directory exists.
STUB = f"""#!{BASH}
exists=no; [[ -d "${{E2E_RELAY_DIR:-/nonexistent}}" ]] && exists=yes
printf '%s{SEP}%s{SEP}%s{SEP}%s{SEP}%s{SEP}%s\\n' "$(basename "$0") $*" "$PWD" \\
    "${{E2E_WEB_PORTS:-}}" "${{E2E_RELAY_PORTS:-}}" "${{E2E_RELAY_DIR:-}}" \\
    "$exists" >> "$STUB_LOG"
"""


@dataclass(frozen=True)
class Call:
    """One logged stub call."""

    command: str
    cwd: str
    web_ports: list[str]
    relay_ports: list[str]
    relay_dir: str
    relay_dir_existed: bool


@dataclass(frozen=True)
class Run:
    """How a run of e2e.sh went."""

    code: int
    calls: list[Call]
    tmp: Path
    stderr: str


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """client/scripts/e2e.sh with installed node_modules and npm/npx stubs."""
    scripts = tmp_path / "client" / "scripts"
    scripts.mkdir(parents=True)
    shutil.copy(E2E, scripts / "e2e.sh")
    (tmp_path / "client" / "node_modules").mkdir()
    (tmp_path / "bin").mkdir()
    (tmp_path / "tmp").mkdir()
    return tmp_path


def _stub(tree: Path, tool: str, exit_code: int = 0, then: str = "") -> None:
    """Put a logging stub for ``tool`` on the tree's PATH; it runs ``then`` last."""
    path = tree / "bin" / tool
    path.write_text(f"{STUB}{then}\nexit {exit_code}\n", "utf-8")
    path.chmod(0o755)


def _run(tree: Path, *args: str, env: dict[str, str] | None = None) -> Run:
    """Run the copied e2e.sh with the stubs first on PATH and TMPDIR in the tree."""
    for tool in ("npm", "npx"):
        if not (tree / "bin" / tool).exists():
            _stub(tree, tool)
    log = tree / "calls.log"
    python_dir = str(Path(sys.executable).parent)
    result = subprocess.run(  # nosec B603 - fixed argv, no shell
        [BASH, str(tree / "client" / "scripts" / "e2e.sh"), *args],
        env={
            "PATH": os.pathsep.join(
                [str(tree / "bin"), python_dir, "/usr/bin", "/bin"]
            ),
            "TMPDIR": str(tree / "tmp"),
            "STUB_LOG": str(log),
            **(env or {}),
        },
        capture_output=True,
        text=True,
        check=False,
    )
    lines = log.read_text("utf-8").splitlines() if log.exists() else []
    calls = []
    for line in lines:
        command, cwd, web, relay, relay_dir, existed = line.split(SEP)
        calls.append(
            Call(command, cwd, web.split(), relay.split(), relay_dir, existed == "yes")
        )
    return Run(result.returncode, calls, tree / "tmp", result.stderr)


def _is_free(port: int) -> bool:
    """Whether a server could listen on 127.0.0.1:``port`` now."""
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def test_builds_then_runs_playwright_on_free_ports_and_a_temp_dir(tree: Path) -> None:
    """Build, then test, from client/, with free ports for two workers and a new dir.

    Each worker gets a web port and a relay port of its own, so no two servers
    ever share one.
    """
    run = _run(tree)
    assert run.code == 0
    assert [call.command for call in run.calls] == [
        "npm run build",
        "npx playwright test",
    ]
    test = run.calls[1]
    assert test.cwd == str(tree / "client")
    assert len(test.web_ports) == len(test.relay_ports) == 2
    ports = {int(port) for port in test.web_ports + test.relay_ports}
    assert len(ports) == 4
    assert all(1024 <= port <= 65535 and _is_free(port) for port in ports)
    assert Path(test.relay_dir).parent == run.tmp
    assert test.relay_dir_existed


def test_e2e_workers_sets_how_many_workers_get_servers(tree: Path) -> None:
    """``E2E_WORKERS=3`` picks three distinct pairs of ports; 1 picks one pair."""
    for workers in (1, 3):
        test = _run(tree, env={"E2E_WORKERS": str(workers)}).calls[-1]
        assert len(test.web_ports) == len(test.relay_ports) == workers
        assert len(set(test.web_ports + test.relay_ports)) == 2 * workers


@pytest.mark.parametrize("workers", ["0", "two", "-1", "1.5"])
def test_e2e_workers_must_be_a_positive_whole_number(tree: Path, workers: str) -> None:
    """A bad worker count stops the run before the build, saying why."""
    run = _run(tree, env={"E2E_WORKERS": workers})
    assert run.code == 2
    assert run.calls == []
    assert "E2E_WORKERS" in run.stderr


def test_failing_loop_prints_each_relays_output(tree: Path) -> None:
    """A failed run shows what each worker's relay printed before it is deleted."""
    _stub(
        tree,
        "npx",
        exit_code=1,
        then='echo "relay one said hi" > "$E2E_RELAY_DIR/relay-1.log"',
    )
    run = _run(tree)
    assert run.code == 1
    assert "relay-1.log" in run.stderr
    assert "relay one said hi" in run.stderr
    assert list(run.tmp.iterdir()) == []


def test_deletes_the_temp_dir_after_a_run(tree: Path) -> None:
    """Nothing the relay wrote outlives the run."""
    run = _run(tree)
    assert run.code == 0
    assert list(run.tmp.iterdir()) == []


def test_failing_loop_fails_and_still_deletes_the_temp_dir(tree: Path) -> None:
    """Playwright's exit code is the script's, and cleanup still happens."""
    _stub(tree, "npx", exit_code=3)
    run = _run(tree)
    assert run.code == 3
    assert list(run.tmp.iterdir()) == []


def test_failed_build_stops_before_playwright(tree: Path) -> None:
    """A build that fails never reaches the browsers."""
    _stub(tree, "npm", exit_code=1)
    run = _run(tree)
    assert run.code == 1
    assert [call.command for call in run.calls] == ["npm run build"]


def test_extra_arguments_go_to_playwright(tree: Path) -> None:
    """``--grep nomatch`` and the like reach ``playwright test`` unchanged."""
    run = _run(tree, "--grep", "nomatch")
    assert run.calls[-1].command == "npx playwright test --grep nomatch"


def test_verbose_is_the_scripts_own_flag(tree: Path) -> None:
    """check-all passes ``--verbose``; Playwright never sees it."""
    run = _run(tree, "--verbose")
    assert run.code == 0
    assert run.calls[-1].command == "npx playwright test"


def test_e2e_projects_narrows_the_browsers(tree: Path) -> None:
    """A laptop without WebKit can run Chromium alone; CI never sets this."""
    run = _run(tree, env={"E2E_PROJECTS": "chromium"})
    assert run.calls[-1].command == "npx playwright test --project=chromium"


def test_installs_dependencies_when_missing(tree: Path) -> None:
    """A fresh checkout gets the locked dependencies first, as client.sh does."""
    (tree / "client" / "node_modules").rmdir()
    run = _run(tree)
    assert [call.command for call in run.calls] == [
        "npm ci",
        "npm run build",
        "npx playwright test",
    ]
