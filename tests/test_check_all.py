"""Tests for how scripts/check-all.sh routes the deploy area to deploy/check.sh.

The tests run a copy of check-all.sh in a temp tree whose deploy/check.sh and
changed-areas.sh are stubs, so they check the routing, not Caddy or systemd.
"""

from __future__ import annotations

import shutil
import subprocess  # nosec B404 - runs our own script in a temp tree
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CHECK_ALL = ROOT / "scripts" / "check-all.sh"
BASH = shutil.which("bash") or "bash"
RAN = "stub deploy/check.sh ran with:"


def _stub(path: Path, body: str) -> None:
    """Write an executable bash script at ``path``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!/usr/bin/env bash\n{body}\n", encoding="utf-8")
    path.chmod(0o755)


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """check-all.sh beside a deploy/check.sh stub that exits with $STUB_EXIT."""
    (tmp_path / "scripts").mkdir()
    shutil.copy(CHECK_ALL, tmp_path / "scripts" / "check-all.sh")
    _stub(tmp_path / "deploy" / "check.sh", f'echo "{RAN} $*"; exit "$STUB_EXIT"')
    return tmp_path


def _check_all(tree: Path, *args: str, stub_exit: int = 0) -> tuple[int, str]:
    """Run the copied check-all.sh; return its exit code and its stdout."""
    result = subprocess.run(  # nosec B603 - fixed argv, no shell
        [BASH, str(tree / "scripts" / "check-all.sh"), *args],
        env={"PATH": "/usr/bin:/bin", "STUB_EXIT": str(stub_exit)},
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode, result.stdout


def test_deploy_flag_runs_only_the_deploy_check(tree: Path) -> None:
    """``--deploy`` (CI's deploy job) runs deploy/check.sh and nothing else."""
    code, out = _check_all(tree, "--deploy")
    assert code == 0
    assert f"{RAN} \n" in out
    assert "✓ Deploy config (Caddy, systemd) passed" in out
    assert "Passed: 1\nFailed: 0" in out


def test_verbose_reaches_the_deploy_check(tree: Path) -> None:
    """``--verbose`` is passed on, as it is to every other check."""
    _code, out = _check_all(tree, "--deploy", "--verbose")
    assert f"{RAN} --verbose\n" in out


def test_failing_deploy_check_fails_check_all(tree: Path) -> None:
    """A failing deploy/check.sh makes check-all exit 1 and name it."""
    code, out = _check_all(tree, "--deploy", stub_exit=1)
    assert code == 1
    assert "  ✗ Deploy config (Caddy, systemd)" in out


def test_changed_deploy_area_runs_the_deploy_check(tree: Path) -> None:
    """When the router says only deploy changed, only the deploy check runs."""
    _stub(
        tree / "scripts" / "changed-areas.sh",
        'printf "python=false\\nclient=false\\ndeploy=true\\n"',
    )
    code, out = _check_all(tree)
    assert code == 0
    assert "Changed areas: python=false client=false deploy=true" in out
    assert "Passed: 1\nFailed: 0" in out


def test_python_and_client_flags_skip_the_deploy_check(tree: Path) -> None:
    """CI's other jobs don't run the deploy check (it needs Caddy installed)."""
    for flag in ("--python", "--client"):
        _code, out = _check_all(tree, flag, stub_exit=1)
        assert RAN not in out, flag
