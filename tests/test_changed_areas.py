"""Tests for scripts/changed-areas.sh, the router shared by check-all and CI."""

from __future__ import annotations

import os
import shutil
import subprocess  # nosec B404 - runs our own script and git in a temp repo
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "changed-areas.sh"
CI = ROOT / ".github" / "workflows" / "ci.yml"
GIT = shutil.which("git") or "git"
BASH = shutil.which("bash") or "bash"
AREAS = ("python", "client", "deploy", "e2e")
NONE = dict.fromkeys(AREAS, "false")
EVERY = dict.fromkeys(AREAS, "true")


def _git(repo: Path, *args: str) -> None:
    """Run git in repo with a throwaway identity."""
    subprocess.run(  # nosec B603 - fixed argv, no shell
        [GIT, "-c", "user.name=t", "-c", "user.email=t@t", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


def _commit(repo: Path, path: str) -> None:
    """Commit a new file at ``path`` (relative to ``repo``) on top of HEAD."""
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("changed\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", f"touch {path}")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repo on main whose single commit touched only docs."""
    (tmp_path / "scripts").mkdir()
    shutil.copy(SCRIPT, tmp_path / "scripts" / "changed-areas.sh")
    _git(tmp_path, "init", "-q", "-b", "main")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-q", "-m", "base")
    _commit(tmp_path, "docs/note.md")
    return tmp_path


def _areas(repo: Path, base_ref: str | None, *args: str) -> dict[str, str]:
    """Run the router in repo with ``args`` and parse its key=value output."""
    env = {k: v for k, v in os.environ.items() if k != "BASE_REF"}
    if base_ref is not None:
        env["BASE_REF"] = base_ref
    out = subprocess.run(  # nosec B603 - fixed argv, no shell
        [BASH, str(repo / "scripts" / "changed-areas.sh"), *args],
        cwd=repo,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return dict(line.split("=", 1) for line in out.split())


def test_docs_only_change_needs_no_code_gate(repo: Path) -> None:
    """A docs-only commit against a known base routes to no area."""
    assert _areas(repo, "HEAD~1") == NONE


def test_unresolvable_base_ref_checks_everything(repo: Path) -> None:
    """A force-push hands CI a 'before' sha that no longer exists: run all."""
    missing = "deadbeef" * 5  # a well-formed sha that exists nowhere
    assert _areas(repo, missing) == EVERY


def test_all_flag_checks_every_area(repo: Path) -> None:
    """``--all`` forces every area, deploy and e2e included, whatever changed."""
    assert _areas(repo, "HEAD~1", "--all") == EVERY


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("deploy/Caddyfile", {"deploy"}),
        ("deploy/reconcile-purge.timer", {"deploy"}),
        ("deploy/deploy.sh", {"deploy"}),
        # Matched before *.md: the runbook lives beside the config it explains.
        ("deploy/README.md", {"deploy"}),
        # deploy/check.sh holds vite preview's CSP equal to the Caddyfile's.
        ("client/vite.config.ts", {"client", "deploy", "e2e"}),
        # The loop runs the app and the relay, so either one changing runs it.
        ("client/src/main.tsx", {"client", "e2e"}),
        ("client/e2e/loop.spec.ts", {"client", "e2e"}),
        ("reconcile/relay/app.py", {"python", "e2e"}),
        # The relay's runtime dependencies and its start script change what it runs.
        ("requirements.txt", {"python", "e2e"}),
        ("requirements-dev.txt", {"python"}),
        ("scripts/relay.sh", set(AREAS)),
        # tests/test_e2e_script.py checks e2e.sh's ports, temp dir and order.
        ("client/scripts/e2e.sh", {"client", "python", "e2e"}),
        ("tests/test_relay.py", {"python"}),
        # Stubs only change what mypy sees (#89's py-vapid types).
        ("stubs/py_vapid/__init__.pyi", {"python"}),
        ("pyproject.toml", {"python"}),
        ("scripts/check-all.sh", set(AREAS)),
        (".github/workflows/ci.yml", set(AREAS)),
        ("an-unrecognized-file", set(AREAS)),
        ("README.md", set()),
        (".gitignore", set()),
    ],
)
def test_path_routes_to_its_areas(repo: Path, path: str, expected: set[str]) -> None:
    """Each path turns on exactly the areas whose checks it can break."""
    _commit(repo, path)
    assert _areas(repo, "HEAD~1") == {
        area: str(area in expected).lower() for area in AREAS
    }


def test_router_emits_exactly_the_known_areas() -> None:
    """The real router, forced, names the four areas in order and nothing else."""
    out = subprocess.run(  # nosec B603 - fixed argv, no shell
        [BASH, str(SCRIPT), "--all"], check=True, capture_output=True, text=True
    ).stdout
    assert out.split() == [f"{area}=true" for area in AREAS]


def test_ci_gates_every_area_on_its_own_check_all_job() -> None:
    """Each area has one CI job that runs on it, calls check-all, and gate needs.

    So CI runs the same script as a laptop (``./scripts/check-all.sh --<area>``),
    and a failing area job blocks the merge.
    """
    jobs = yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]
    assert sorted(jobs["changes"]["outputs"]) == sorted(AREAS)
    for area in AREAS:
        gated = [
            name
            for name, job in jobs.items()
            if job.get("if") == f"needs.changes.outputs.{area} == 'true'"
        ]
        assert len(gated) == 1, area
        steps = jobs[gated[0]]["steps"]
        assert f"./scripts/check-all.sh --{area}" in [s.get("run") for s in steps]
        assert gated[0] in jobs["gate"]["needs"]


def test_ci_e2e_job_installs_and_runs_both_browsers() -> None:
    """CI's e2e job installs Chromium and WebKit and never narrows the run.

    ``E2E_PROJECTS`` lets a laptop without WebKit run Chromium alone; CI must
    run every project in client/playwright.config.ts.
    """
    job = yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]["e2e"]
    runs = "\n".join(step.get("run", "") for step in job["steps"])
    assert "npx playwright install --with-deps chromium webkit" in runs
    assert "E2E_PROJECTS" not in CI.read_text(encoding="utf-8")
