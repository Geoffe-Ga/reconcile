"""Tests for scripts/analyze_mutations.py, the reader for mutmut's cache.

Each test writes a small cache with the tables mutmut 2.x creates (SourceFile,
Line, Mutant), keeping only the columns the script reads.
"""

from __future__ import annotations

import contextlib
import sqlite3
from typing import TYPE_CHECKING

import pytest

from scripts import analyze_mutations

if TYPE_CHECKING:
    from pathlib import Path

Mutants = list[tuple[str, int, str]]

KILLED, SURVIVED = "ok_killed", "bad_survived"

# Mutant ids follow list order, from 1.
MIXED: Mutants = [
    ("reconcile/a.py", 10, KILLED),
    ("reconcile/a.py", 11, SURVIVED),
    ("reconcile/a.py", 12, SURVIVED),
    ("scripts/b.py", 5, SURVIVED),
    ("scripts/b.py", 3, KILLED),
    ("scripts/b.py", 4, KILLED),
    ("scripts/b.py", 6, "ok_suspicious"),
    ("scripts/b.py", 7, "bad_timeout"),
    ("scripts/b.py", 8, "untested"),
    ("reconcile/a.py", 13, KILLED),
    ("reconcile/a.py", 14, KILLED),
]

MIXED_REPORT = """\
=== Mutmut Cache Analysis ===

Total mutants: 11

Status counts:
  bad_survived: 3
  bad_timeout: 1
  ok_killed: 5
  ok_suspicious: 1
  untested: 1

Mutation Score: 50.0%
Required: 80%

Breakdown:
  Killed: 5 (50.0% of tested)
  Survived: 3 (30.0% of tested)
  Suspicious: 1 (10.0%)
  Timeout: 1 (10.0%)
  Untested: 1

⚠️  Need to kill 3 more mutants to reach 80%

=== Files with Most Survived Mutants (Top 20) ===
    2 ( 66.7%): reconcile/a.py
    1 ( 33.3%): scripts/b.py

Sample of survived mutants (first 10):
  Mutant 2: reconcile/a.py:11
  Mutant 3: reconcile/a.py:12
  Mutant 4: scripts/b.py:5

To view a specific mutant: mutmut show <id>
To generate HTML report: mutmut html
"""

# MIXED filtered to b.py and the top file: 6 mutants, 1 untested, 2 of 5 killed.
FILTERED_REPORT = """\
=== Mutmut Cache Analysis (filtered: b.py) ===

Total mutants: 6

Status counts:
  bad_survived: 1
  bad_timeout: 1
  ok_killed: 2
  ok_suspicious: 1
  untested: 1

Mutation Score: 40.0%
Required: 80%

Breakdown:
  Killed: 2 (40.0% of tested)
  Survived: 1 (20.0% of tested)
  Suspicious: 1 (20.0%)
  Timeout: 1 (20.0%)
  Untested: 1

⚠️  Need to kill 2 more mutants to reach 80%

=== Files with Most Survived Mutants (Top 1) ===
    1 (100.0%): scripts/b.py

Sample of survived mutants (first 10):
  Mutant 4: scripts/b.py:5

To view a specific mutant: mutmut show <id>
To generate HTML report: mutmut html
"""


def _cache(path: Path, mutants: Mutants) -> Path:
    """Write a mutmut-shaped cache holding ``mutants`` and return its path."""
    names = sorted({name for name, _, _ in mutants})
    with contextlib.closing(sqlite3.connect(path)) as conn:
        conn.executescript(
            "CREATE TABLE SourceFile (id INTEGER PRIMARY KEY, filename TEXT);"
            "CREATE TABLE Line (id INTEGER PRIMARY KEY, sourcefile INTEGER,"
            " line_number INTEGER);"
            "CREATE TABLE Mutant (id INTEGER PRIMARY KEY, line INTEGER, status TEXT);"
        )
        conn.executemany("INSERT INTO SourceFile VALUES (?, ?)", enumerate(names, 1))
        for row, (name, line_number, status) in enumerate(mutants, 1):
            file_id = names.index(name) + 1
            conn.execute(
                "INSERT INTO Line VALUES (?, ?, ?)", (row, file_id, line_number)
            )
            conn.execute("INSERT INTO Mutant VALUES (?, ?, ?)", (row, row, status))
        conn.commit()
    return path


def _statuses(**counts: int) -> Mutants:
    """Build mutants in one file from status counts, e.g. ``ok_killed=3``."""
    statuses = [status for status, count in counts.items() for _ in range(count)]
    return [("pkg/mod.py", line, status) for line, status in enumerate(statuses, 1)]


def _report(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], mutants: Mutants
) -> str:
    """Analyze a cache of ``mutants`` with the defaults and return the report."""
    analyze_mutations.analyze_cache(_cache(tmp_path / "cache", mutants))
    return capsys.readouterr().out


def test_report_lists_counts_score_and_survivors(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The full report: counts, score over tested mutants, gap, and survivors."""
    assert _report(tmp_path, capsys, MIXED) == MIXED_REPORT


def test_main_filters_by_file_and_limits_top_files(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The CLI passes the filename filter, --cache, and --top through."""
    cache = _cache(tmp_path / "cache", MIXED)
    argv = ["analyze_mutations.py", "b.py", "--cache", str(cache), "--top", "1"]
    monkeypatch.setattr("sys.argv", argv)
    analyze_mutations.main()
    assert capsys.readouterr().out == FILTERED_REPORT


def test_main_defaults_to_the_cache_in_the_working_directory(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no arguments the CLI reads ./.mutmut-cache and shows the top 20."""
    _cache(tmp_path / ".mutmut-cache", MIXED)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("sys.argv", ["analyze_mutations.py"])
    analyze_mutations.main()
    assert capsys.readouterr().out == MIXED_REPORT


def test_missing_cache_exits_1_with_a_hint(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A missing cache prints where it looked and how to make one, then exits 1."""
    missing = tmp_path / ".mutmut-cache"
    with pytest.raises(SystemExit) as exit_info:
        analyze_mutations.analyze_cache(missing)
    captured = capsys.readouterr()
    assert exit_info.value.code == 1
    assert captured.out == ""
    assert captured.err == (
        f"Error: Cache file not found: {missing}\n"
        "Run mutation tests first: ./scripts/mutation.sh\n"
    )


def test_score_at_the_threshold_shows_no_gap(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Exactly 80% meets the bar, so there's no "Need to kill" line."""
    out = _report(tmp_path, capsys, _statuses(ok_killed=4, bad_survived=1))
    assert "Mutation Score: 80.0%\n" in out
    assert "Need to kill" not in out


@pytest.mark.parametrize(
    ("killed", "survived", "gap"),
    [(3, 1, 1), (7, 3, 1), (0, 5, 4), (11, 4, 1)],
)
def test_gap_is_the_mutants_still_to_kill(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    killed: int,
    survived: int,
    gap: int,
) -> None:
    """The gap rounds up: 3 of 4 killed needs 1 more to reach 80%, not 0."""
    mutants = _statuses(ok_killed=killed, bad_survived=survived)
    out = _report(tmp_path, capsys, mutants)
    assert f"⚠️  Need to kill {gap} more mutants to reach 80%\n" in out


def test_no_survivors_skips_the_survivor_sections(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """With every tested mutant killed, there are no survivor tables."""
    out = _report(tmp_path, capsys, _statuses(ok_killed=2, untested=1))
    assert "Mutation Score: 100.0%\n" in out
    assert "  Untested: 1\n" in out
    assert "Survived Mutants" not in out
    assert "mutmut show" not in out


def test_all_untested_prints_no_score(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """With nothing tested, there's no score to divide out, so none is printed."""
    out = _report(tmp_path, capsys, _statuses(untested=2))
    assert out == (
        "=== Mutmut Cache Analysis ===\n\n"
        "Total mutants: 2\n\n"
        "Status counts:\n"
        "  untested: 2\n\n"
    )
