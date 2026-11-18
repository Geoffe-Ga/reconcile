"""Tests for client/scripts/audit.sh, the client's dependency audit (#495).

The tests run a copy of audit.sh and its parser in a temp tree whose ``npm``
is a stub on PATH. The stub answers ``npm audit --omit=dev`` with a chosen
exit code and ``npm audit --json`` with a chosen report, so the tests check
the script's own rules without the registry:

- production dependencies get no exception: any advisory there fails;
- a dev-only advisory passes only while it is on the known list, with an
  ``expires=`` date that hasn't passed and is at most 30 days out;
- any other advisory, or a malformed list entry, fails.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess  # nosec B404 - runs our own script in a temp tree
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "client" / "scripts"
BASH = shutil.which("bash") or "bash"
NODE = shutil.which("node")
GHSA = "GHSA-fc5q-39xc-vjpf"
OTHER = "GHSA-aaaa-bbbb-cccc"
TODAY = "2026-11-18"

pytestmark = pytest.mark.skipif(NODE is None, reason="the audit's parser runs on Node")

# Answers `npm audit --omit=dev ...` with $STUB_PROD_EXIT, and `npm audit --json ...`
# with the report in $STUB_REPORT and exit 1 when it holds any advisory, as npm does.
STUB = f"""#!{BASH}
if [[ " $* " == *" --omit=dev "* ]]; then
    echo "stub: production audit"
    exit "${{STUB_PROD_EXIT:-0}}"
fi
cat "$STUB_REPORT"
grep -q '"via"' "$STUB_REPORT" && exit 1
exit 0
"""


def advisory(ghsa: str, severity: str = "high") -> dict[str, object]:
    """One advisory as `npm audit --json` lists it under a package's `via`."""
    return {
        "source": 1,
        "name": "picomatch",
        "title": "A test advisory",
        "url": f"https://github.com/advisories/{ghsa}",
        "severity": severity,
        "range": "<=4.0.7",
    }


def report(*advisories: dict[str, object]) -> dict[str, object]:
    """An `npm audit --json` report of `advisories`, and a package depending on them."""
    if not advisories:
        return {"vulnerabilities": {}}
    first = advisories[0]
    return {
        "vulnerabilities": {
            "picomatch": {"severity": first["severity"], "via": list(advisories)},
            "vite": {"severity": first["severity"], "via": ["picomatch"]},
        }
    }


@dataclass(frozen=True)
class Run:
    """How a run of audit.sh went."""

    code: int
    out: str


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """A copy of client/scripts in a temp client/, with a stub npm on PATH."""
    client = tmp_path / "client"
    shutil.copytree(SCRIPTS, client / "scripts")
    stubs = tmp_path / "bin"
    stubs.mkdir()
    npm = stubs / "npm"
    npm.write_text(STUB)
    npm.chmod(0o755)
    return tmp_path


def run(
    tree: Path, full: dict[str, object], known: str | None, prod_exit: int = 0
) -> Run:
    """Runs audit.sh with `full` as the whole audit's report and `known` as the list."""
    client = tree / "client"
    report_file = tree / "report.json"
    report_file.write_text(json.dumps(full))
    if known is not None:
        (client / ".npm-audit-known-vulnerabilities").write_text(known)
    env = {
        **os.environ,
        "PATH": f"{tree / 'bin'}{os.pathsep}{os.environ['PATH']}",
        "STUB_REPORT": str(report_file),
        "STUB_PROD_EXIT": str(prod_exit),
        "AUDIT_TODAY": TODAY,
    }
    done = subprocess.run(  # nosec B603 - our own script, fixed arguments
        [BASH, str(client / "scripts" / "audit.sh")],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    return Run(done.returncode, done.stdout + done.stderr)


def entry(ghsa: str = GHSA, expires: str = "2026-12-18") -> str:
    """One line of the known list."""
    return (
        f"{ghsa}  expires={expires}  # picomatch - no patched release - tracking #495\n"
    )


def test_passes_with_no_advisory_and_no_list(tree: Path) -> None:
    done = run(tree, report(), None)
    assert done.code == 0, done.out
    assert "✓" in done.out


def test_fails_on_any_production_advisory_whatever_the_list_says(tree: Path) -> None:
    done = run(tree, report(advisory(GHSA)), entry(), prod_exit=1)
    assert done.code == 1
    assert "production" in done.out


def test_passes_a_listed_dev_advisory_before_it_expires_and_names_it(
    tree: Path,
) -> None:
    done = run(tree, report(advisory(GHSA)), entry())
    assert done.code == 0, done.out
    assert GHSA in done.out
    assert "2026-12-18" in done.out


def test_fails_on_a_dev_advisory_not_on_the_list(tree: Path) -> None:
    done = run(tree, report(advisory(GHSA), advisory(OTHER, "moderate")), entry())
    assert done.code == 1
    assert OTHER in done.out


def test_fails_once_a_listed_advisory_has_expired(tree: Path) -> None:
    done = run(tree, report(advisory(GHSA)), entry(expires="2026-11-17"))
    assert done.code == 1
    assert "expired" in done.out


def test_fails_on_an_expiry_more_than_30_days_out(tree: Path) -> None:
    done = run(tree, report(advisory(GHSA)), entry(expires="2026-12-19"))
    assert done.code == 1
    assert "30 days" in done.out


def test_passes_on_the_last_day_of_the_exception(tree: Path) -> None:
    done = run(tree, report(advisory(GHSA)), entry(expires=TODAY))
    assert done.code == 0, done.out


@pytest.mark.parametrize(
    "line",
    [
        f"{GHSA}  # no expiry - tracking #495\n",
        f"{GHSA}  expires=soon  # tracking #495\n",
        "not-an-advisory  expires=2026-12-01  # tracking #495\n",
        f"{GHSA}  expires=2026-12-01\n",
    ],
)
def test_fails_on_a_malformed_list_entry(tree: Path, line: str) -> None:
    done = run(tree, report(advisory(GHSA)), line)
    assert done.code == 1
    assert "known-vulnerabilities" in done.out


def test_ignores_comments_blank_lines_and_low_severity(tree: Path) -> None:
    known = "# Header comment.\n\n" + entry()
    done = run(tree, report(advisory(GHSA), advisory(OTHER, "low")), known)
    assert done.code == 0, done.out


def test_lists_nothing_stale_without_failing(tree: Path) -> None:
    """An entry whose advisory npm no longer reports is named, so it can be removed."""
    done = run(tree, report(), entry())
    assert done.code == 0, done.out
    assert "no longer reported" in done.out
