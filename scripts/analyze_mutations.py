#!/usr/bin/env python3
"""Analyze mutmut cache database for mutation testing insights.

This script provides detailed analysis of mutation testing results including:
- Overall mutation score and statistics
- Files with the most surviving mutants
- Sample of specific surviving mutants for debugging

Usage:
    ./scripts/analyze_mutations.py
    python scripts/analyze_mutations.py --top 10
"""

import argparse
import contextlib
import math
import sqlite3
import sys
from pathlib import Path

# Quality thresholds
MINIMUM_MUTATION_SCORE = 80


# Every query joins mutants to their source file and filters by filename. The
# filter is always applied ("%" matches every file), so each statement is a
# static string with bound parameters only.
_JOIN = """
    FROM Mutant m, Line l, SourceFile sf
    WHERE m.line = l.id
      AND l.sourcefile = sf.id
      AND sf.filename LIKE ?
"""
_TOTAL_SQL = "SELECT COUNT(*)" + _JOIN
_STATUS_SQL = "SELECT m.status, COUNT(*)" + _JOIN + "GROUP BY m.status"
_TOP_FILES_SQL = (
    "SELECT sf.filename, COUNT(*) AS count"
    + _JOIN
    + 'AND m.status = "bad_survived" GROUP BY sf.filename ORDER BY count DESC LIMIT ?'
)
_SAMPLE_SQL = (
    "SELECT m.id, sf.filename, l.line_number"
    + _JOIN
    + 'AND m.status = "bad_survived" ORDER BY sf.filename, l.line_number LIMIT 10'
)


def _print_score(status_counts: dict[str, int], total: int) -> None:
    """Print the mutation score, its breakdown, and the gap to the threshold."""
    killed = status_counts.get("ok_killed", 0)
    untested = status_counts.get("untested", 0)
    tested_total = total - untested
    if tested_total <= 0:
        return
    score = (killed / tested_total) * 100
    print(f"Mutation Score: {score:.1f}%")
    print(f"Required: {MINIMUM_MUTATION_SCORE}%")
    print()
    print("Breakdown:")
    rows = [
        ("Killed", "ok_killed", " of tested"),
        ("Survived", "bad_survived", " of tested"),
        ("Suspicious", "ok_suspicious", ""),
        ("Timeout", "bad_timeout", ""),
    ]
    for label, status, suffix in rows:
        count = status_counts.get(status, 0)
        print(f"  {label}: {count} ({count / tested_total * 100:.1f}%{suffix})")
    print(f"  Untested: {untested}")
    print()
    if score < MINIMUM_MUTATION_SCORE:
        # Round the kills needed up, in exact integer-over-100 arithmetic: 3 of 4
        # killed needs a 4th to reach 80%, and 80% of 15 is 12, not 12.000...02.
        gap = math.ceil(MINIMUM_MUTATION_SCORE * tested_total / 100) - killed
        print(f"⚠️  Need to kill {gap} more mutants to reach {MINIMUM_MUTATION_SCORE}%")
        print()


def _print_survivors(
    cursor: sqlite3.Cursor, pattern: str, survived: int, top_files: int
) -> None:
    """Print the files with the most surviving mutants and a sample of them."""
    print(f"=== Files with Most Survived Mutants (Top {top_files}) ===")
    cursor.execute(_TOP_FILES_SQL, (pattern, top_files))
    for filename, count in cursor.fetchall():
        percentage = (count / survived) * 100
        print(f"  {count:3d} ({percentage:5.1f}%): {filename}")
    print()
    print("Sample of survived mutants (first 10):")
    cursor.execute(_SAMPLE_SQL, (pattern,))
    for mutant_id, filename, line_number in cursor.fetchall():
        print(f"  Mutant {mutant_id}: {filename}:{line_number}")
    print()
    print("To view a specific mutant: mutmut show <id>")
    print("To generate HTML report: mutmut html")


def analyze_cache(
    cache_path: Path, top_files: int = 20, filter_file: str | None = None
) -> None:
    """Analyze mutmut cache and print detailed statistics.

    Args:
        cache_path: Path to .mutmut-cache file.
        top_files: Number of top files to show (default: 20).
        filter_file: Optional filename to filter results (e.g., "cli.py").
    """
    if not cache_path.exists():
        print(f"Error: Cache file not found: {cache_path}", file=sys.stderr)
        print("Run mutation tests first: ./scripts/mutation.sh", file=sys.stderr)
        sys.exit(1)

    pattern = f"%{filter_file}" if filter_file else "%"
    suffix = f" (filtered: {filter_file})" if filter_file else ""
    print(f"=== Mutmut Cache Analysis{suffix} ===\n")

    # closing() releases the file even when a malformed cache raises mid-query.
    with contextlib.closing(sqlite3.connect(cache_path)) as conn:
        cursor = conn.cursor()
        cursor.execute(_TOTAL_SQL, (pattern,))
        total = cursor.fetchone()[0]
        print(f"Total mutants: {total}")
        print()

        cursor.execute(_STATUS_SQL, (pattern,))
        status_counts = dict(cursor.fetchall())
        print("Status counts:")
        for status, count in sorted(status_counts.items()):
            print(f"  {status}: {count}")
        print()

        _print_score(status_counts, total)
        survived = status_counts.get("bad_survived", 0)
        if survived > 0:
            _print_survivors(cursor, pattern, survived, top_files)


def main() -> None:
    """Parse arguments and run cache analysis."""
    parser = argparse.ArgumentParser(
        description="Analyze mutation testing results from .mutmut-cache",
        epilog="Examples:\n"
        "  %(prog)s                  # Analyze all files\n"
        "  %(prog)s cli.py           # Analyze only cli.py\n"
        "  %(prog)s --cache .cache   # Use custom cache file\n",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "filename",
        nargs="?",
        help="Optional filename to filter results (e.g., 'cli.py')",
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=Path(".mutmut-cache"),
        help="Path to mutmut cache file (default: .mutmut-cache)",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=20,
        help="Number of top files to show (default: 20)",
    )

    args = parser.parse_args()
    analyze_cache(args.cache, args.top, args.filename)


if __name__ == "__main__":
    main()
