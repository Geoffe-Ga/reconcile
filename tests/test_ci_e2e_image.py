"""Where ci.yml's end-to-end job gets its browsers and their system packages.

``npx playwright install --with-deps`` fetched about 140 MB of Ubuntu packages
from the runner's apt mirror on every run. The mirror stalled it for 26, 46
and 96 minutes, and on 2026-11-18 twice in a row past the step's 10-minute
limit, before any test ran. The job now runs in Playwright's own image for
the locked version, which already holds Chromium, WebKit and every package
they need, so no apt mirror stands between a PR and its tests.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
CI = ROOT / ".github" / "workflows" / "ci.yml"
LOCK = ROOT / "client" / "package-lock.json"
IMAGE = "mcr.microsoft.com/playwright"
# The image's Ubuntu matches ubuntu-latest's (26.04), which WebKit is built for.
UBUNTU = "resolute"


def _e2e() -> dict[str, Any]:
    """The ``e2e`` job, parsed from ci.yml."""
    jobs: dict[str, Any] = yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]
    job: dict[str, Any] = jobs["e2e"]
    return job


def _locked_playwright() -> str:
    """The playwright-core version client/package-lock.json pins."""
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    version: str = lock["packages"]["node_modules/playwright-core"]["version"]
    return version


def _runs(job: dict[str, Any]) -> str:
    """Every ``run:`` script in a job, joined."""
    return "\n".join(str(step.get("run", "")) for step in job["steps"])


def test_e2e_runs_in_the_image_of_the_locked_playwright() -> None:
    """The image's tag follows the lock, so a Playwright bump moves both."""
    container = _e2e()["container"]
    image = container["image"] if isinstance(container, dict) else container
    assert image == f"{IMAGE}:v{_locked_playwright()}-{UBUNTU}"


def test_e2e_installs_no_browser_or_system_package() -> None:
    """The image brings both; nothing reaches an apt mirror or Playwright's CDN."""
    runs = _runs(_e2e())
    assert "playwright install" not in runs
    assert "apt-get" not in runs
    assert "npm ci" in runs


def test_e2e_keeps_no_browser_cache() -> None:
    """The browsers live in the image, so a cache of them would only go stale."""
    uses = [str(step.get("uses", "")) for step in _e2e()["steps"]]
    paths = [str(step.get("with", {}).get("path", "")) for step in _e2e()["steps"]]
    assert not any("ms-playwright" in path for path in paths)
    assert uses.count("actions/cache@v4") == 0
