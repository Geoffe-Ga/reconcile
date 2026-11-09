"""Tests for client/scripts/e2e.sh, which runs the Playwright loop.

The tests run a copy of e2e.sh in a temp tree whose ``npm`` and ``npx`` are
stubs on PATH. Each stub logs what it was asked to run and the environment the
loop would have seen, so the tests check the script's own work (free ports, a
temp relay database that is deleted afterwards, build before test) without a
browser or a relay.
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
# Playwright config reads, and whether the database's directory exists.
STUB = f"""#!{BASH}
db_dir="$(dirname "${{RECONCILE_RELAY_DB:-/nonexistent/db}}")"
exists=no; [[ -d "$db_dir" ]] && exists=yes
printf '%s{SEP}%s{SEP}%s{SEP}%s{SEP}%s{SEP}%s\\n' "$(basename "$0") $*" "$PWD" \\
    "${{E2E_WEB_PORT:-}}" "${{RECONCILE_RELAY_PORT:-}}" "${{RECONCILE_RELAY_DB:-}}" \\
    "$exists" >> "$STUB_LOG"
"""


@dataclass(frozen=True)
class Call:
    """One logged stub call."""

    command: str
    cwd: str
    web_port: str
    relay_port: str
    db: str
    db_dir_existed: bool


@dataclass(frozen=True)
class Run:
    """How a run of e2e.sh went."""

    code: int
    calls: list[Call]
    tmp: Path


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


def _stub(tree: Path, tool: str, exit_code: int = 0) -> None:
    """Put a logging stub for ``tool`` on the tree's PATH."""
    path = tree / "bin" / tool
    path.write_text(f"{STUB}exit {exit_code}\n", "utf-8")
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
        command, cwd, web, relay, db, existed = line.split(SEP)
        calls.append(Call(command, cwd, web, relay, db, existed == "yes"))
    return Run(result.returncode, calls, tree / "tmp")


def _is_free(port: int) -> bool:
    """Whether a server could listen on 127.0.0.1:``port`` now."""
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def test_builds_then_runs_playwright_on_free_ports_and_a_temp_db(tree: Path) -> None:
    """Build, then test, from client/, with two free ports and a fresh database."""
    run = _run(tree)
    assert run.code == 0
    assert [call.command for call in run.calls] == [
        "npm run build",
        "npx playwright test",
    ]
    test = run.calls[1]
    assert test.cwd == str(tree / "client")
    ports = {int(test.web_port), int(test.relay_port)}
    assert len(ports) == 2
    assert all(1024 <= port <= 65535 and _is_free(port) for port in ports)
    assert Path(test.db).parent.parent == run.tmp
    assert test.db_dir_existed


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
