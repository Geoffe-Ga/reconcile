"""Tests for deploy/deploy.sh's first step: every tool it needs is on PATH.

The tests run a copy of deploy.sh in a temp tree, on a PATH that holds only
``dirname`` and a stub for each tool, so nothing is built, synced or
deployed. With every tool there, the script stops at its settings check,
because the tests give it no RECONCILE_* setting and no deploy/.env.
"""

from __future__ import annotations

import shutil
import subprocess  # nosec B404 - runs our own script in a temp tree
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy" / "deploy.sh"
BASH = shutil.which("bash") or "bash"
DIRNAME = shutil.which("dirname") or "/usr/bin/dirname"
# Every command deploy.sh runs on the founder's machine (#155 added git).
TOOLS = ("git", "npm", "rsync", "ssh", "curl", "base64")
STUB_RAN = "stub ran:"
NO_SETTINGS = (
    "deploy: set RECONCILE_DEPLOY_HOST (deploy@<vm>) in the environment"
    " or deploy/.env.\n"
)


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """deploy/deploy.sh beside a bin/ holding dirname and a stub per tool."""
    (tmp_path / "deploy").mkdir()
    shutil.copy(DEPLOY, tmp_path / "deploy" / "deploy.sh")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "dirname").symlink_to(DIRNAME)
    for tool in TOOLS:
        stub = bin_dir / tool
        stub.write_text(
            f'#!{BASH}\necho "{STUB_RAN} {tool} $*"\nexit 99\n', encoding="utf-8"
        )
        stub.chmod(0o755)
    return tmp_path


def _deploy(tree: Path) -> subprocess.CompletedProcess[str]:
    """Run the copied deploy.sh with only tree/bin on PATH and no settings."""
    return subprocess.run(  # nosec B603 - fixed argv, no shell
        [BASH, str(tree / "deploy" / "deploy.sh")],
        env={"PATH": str(tree / "bin")},
        capture_output=True,
        text=True,
        check=False,
    )


def test_with_every_tool_it_reaches_the_settings_check(tree: Path) -> None:
    """The control: with all the tools, the tool check passes and runs none."""
    result = _deploy(tree)
    assert result.returncode == 1
    assert result.stderr == NO_SETTINGS
    assert STUB_RAN not in result.stdout


@pytest.mark.parametrize("missing", TOOLS)
def test_a_missing_tool_stops_the_deploy_first(tree: Path, missing: str) -> None:
    """Without one tool, deploy.sh dies naming it, before using any tool."""
    (tree / "bin" / missing).unlink()
    result = _deploy(tree)
    assert result.returncode == 1
    assert result.stderr == f"deploy: {missing} isn't on PATH.\n"
    assert STUB_RAN not in result.stdout
