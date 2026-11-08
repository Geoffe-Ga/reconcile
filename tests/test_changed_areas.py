"""Tests for scripts/changed-areas.sh, the router shared by check-all and CI."""

from __future__ import annotations

import os
import shutil
import subprocess  # nosec B404 - runs our own script and git in a temp repo
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "changed-areas.sh"
GIT = shutil.which("git") or "git"
BASH = shutil.which("bash") or "bash"


def _git(repo: Path, *args: str) -> None:
    """Run git in repo with a throwaway identity."""
    subprocess.run(  # nosec B603 - fixed argv, no shell
        [GIT, "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repo on main whose single commit touched only docs."""
    (tmp_path / "scripts").mkdir()
    shutil.copy(SCRIPT, tmp_path / "scripts" / "changed-areas.sh")
    _git(tmp_path, "init", "-q", "-b", "main")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-q", "-m", "base")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "note.md").write_text("hi\n", encoding="utf-8")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-q", "-m", "docs only")
    return tmp_path


def _areas(repo: Path, base_ref: str | None) -> dict[str, str]:
    """Run the router in repo and parse its key=value output."""
    env = {k: v for k, v in os.environ.items() if k != "BASE_REF"}
    if base_ref is not None:
        env["BASE_REF"] = base_ref
    out = subprocess.run(  # nosec B603 - fixed argv, no shell
        [BASH, str(repo / "scripts" / "changed-areas.sh")],
        cwd=repo,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return dict(line.split("=", 1) for line in out.split())


def test_docs_only_change_needs_no_code_gate(repo: Path) -> None:
    """A docs-only commit against a known base routes to no area."""
    assert _areas(repo, "HEAD~1") == {"python": "false", "client": "false"}


def test_unresolvable_base_ref_checks_everything(repo: Path) -> None:
    """A force-push hands CI a 'before' sha that no longer exists: run all."""
    missing = "0686b67eb87df48db6c506dee987ea39583bba05"
    assert _areas(repo, missing) == {"python": "true", "client": "true"}
