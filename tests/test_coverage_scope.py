"""The coverage gate measures the configured source, set in one place.

Issue #55: the tested Python under scripts/ joins the >=90% line and >=85%
branch gate. ``[tool.coverage.run] source`` in pyproject.toml is the only list
of what's measured. A ``--cov=<path>`` anywhere else (pytest's addopts, a gate
script, CI) would replace that list and quietly drop scripts/ from the gate,
so these tests forbid one. Mutation testing mutates the same tree.
"""

from __future__ import annotations

import fnmatch
import re
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CONFIG = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
SOURCE = CONFIG["tool"]["coverage"]["run"]["source"]
# --cov=<anything> or --cov <word> names its own source; a bare --cov (next to
# another option or a shell comment) reads SOURCE.
NARROWED_COV = re.compile(r"--cov(?:=|[ \t]+(?![-#])\S)")
GATE_FILES = sorted([*ROOT.glob("scripts/*.sh"), *ROOT.glob(".github/workflows/*.yml")])


def test_source_is_the_package_and_the_scripts_tree() -> None:
    """The gate measures reconcile/ and every Python file under scripts/."""
    assert SOURCE == ["reconcile", "scripts"]


def test_no_omit_rule_hides_a_script() -> None:
    """No omit pattern drops a file under scripts/ from the gate."""
    omit = CONFIG["tool"]["coverage"]["run"]["omit"]
    scripts = sorted((ROOT / "scripts").rglob("*.py"))
    assert scripts
    hidden = [
        path
        for path in scripts
        if any(fnmatch.fnmatch(str(path), pattern) for pattern in omit)
    ]
    assert hidden == []


def test_pytest_addopts_measure_the_configured_source() -> None:
    """Plain pytest measures SOURCE too, not a narrower list."""
    addopts = CONFIG["tool"]["pytest"]["ini_options"]["addopts"]
    assert "--cov" in addopts
    assert [opt for opt in addopts if NARROWED_COV.search(opt)] == []


@pytest.mark.parametrize("path", GATE_FILES, ids=lambda path: path.name)
def test_gate_files_measure_the_configured_source(path: Path) -> None:
    """No gate script or workflow passes --cov a path of its own."""
    assert NARROWED_COV.findall(path.read_text(encoding="utf-8")) == []


def test_mutation_testing_mutates_the_measured_tree() -> None:
    """Mutmut mutates exactly what the coverage gate measures."""
    paths = CONFIG["tool"]["mutmut"]["paths_to_mutate"].split(",")
    assert [path.strip().rstrip("/") for path in paths] == SOURCE


@pytest.mark.parametrize(
    ("text", "narrowed"),
    [
        ("--cov=reconcile", True),
        ("pytest --cov reconcile tests/", True),
        ("--cov=", True),
        ("pytest --cov tests/", True),
        ("--cov --cov-branch", False),
        ("--cov\n    --cov-branch", False),
        ("--cov  # source: pyproject.toml", False),
        ("--cov-report=xml --cov-fail-under=90", False),
    ],
)
def test_narrowed_cov_pattern(text: str, narrowed: bool) -> None:
    """The pattern catches every --cov that names a source and nothing else."""
    assert bool(NARROWED_COV.search(text)) is narrowed
