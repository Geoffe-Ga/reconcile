"""Pure statistics helpers for the Ralph Recap.

Everything in this module is side-effect free: it takes already-fetched data
(timestamps, verdict sequences, churn tuples) and returns plain dicts and
numbers. ``recap.py`` does the GitHub and Discord I/O and hands the data here,
so the math is unit-testable without a network.

A "Ralph tick loop" is an agent working the backlog one issue at a time: each
tick opens a PR, iterates against the review bot's verdict until it may merge,
merges, and moves on. These helpers turn the merge history into the numbers a
human wants to see in a recap. Ported from the adepthood repository.
"""

from __future__ import annotations

import datetime as dt
import itertools
import re
from collections import Counter

# A review-bot verdict, normalized to one of these tokens.
LGTM = "LGTM"
CHANGES_REQUESTED = "CHANGES_REQUESTED"
COMMENTS = "COMMENTS"

HOURS_PER_DAY = 24.0
DAYS_PER_WEEK = 7.0
SECONDS_PER_HOUR = 3600.0

# The verdict line in any of its published shapes ("Verdict: LGTM",
# "## Verdict: COMMENTS", "**Verdict:** CHANGES_REQUESTED"). Anchored to the
# start of a line so verdict tokens mentioned in prose never match.
_VERDICT_LINE = re.compile(
    r"^\s*(?:#+\s*|\*\*)?VERDICT[:*\s]+"
    r"(LGTM|CHANGES_REQUESTED|CHANGES REQUESTED|COMMENTS)\b",
    re.IGNORECASE | re.MULTILINE,
)


def parse_iso(timestamp: str) -> dt.datetime:
    """Parse a GitHub ISO-8601 timestamp (trailing ``Z``) into an aware datetime."""
    return dt.datetime.fromisoformat(timestamp)


def normalize_verdict(raw: str) -> str | None:
    """Collapse a review comment body to a single verdict token.

    Only line-anchored ``Verdict:`` lines count, because review bodies often
    mention the other tokens in prose. When several verdict lines appear, the
    last one wins: earlier ones are usually quotes of a previous round. Returns
    None when no verdict line is present, so non-review comments are ignored.
    """
    matches = _VERDICT_LINE.findall(raw)
    if not matches:
        return None
    return str(matches[-1]).upper().replace(" ", "_")


def iterations_before_lgtm(verdicts: list[str]) -> int | None:
    """Count review rounds a PR took before its first LGTM.

    Returns the number of non-LGTM verdicts that preceded the first LGTM, or
    None when the PR never reached LGTM (for example a COMMENTS merge), so it
    can be excluded from averages.
    """
    for index, verdict in enumerate(verdicts):
        if verdict == LGTM:
            return index
    return None


def _mean(values: list[float]) -> float:
    """Arithmetic mean, or 0.0 for an empty list."""
    return sum(values) / len(values) if values else 0.0


def _median(values: list[float]) -> float:
    """Median, or 0.0 for an empty list."""
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def merge_rate(merged_at: list[dt.datetime], *, now: dt.datetime) -> dict[str, float]:
    """Compute merge throughput over the trailing 24 hours and 7 days.

    Fixed-width windows move with the latest data, and an idle loop decays
    toward zero rather than showing a stale all-time average. The 7-day
    per-day figure is what the backlog ETA is built on.
    """
    day_ago = now - dt.timedelta(hours=HOURS_PER_DAY)
    week_ago = now - dt.timedelta(days=DAYS_PER_WEEK)
    last_24h = sum(1 for ts in merged_at if ts >= day_ago)
    last_7 = sum(1 for ts in merged_at if ts >= week_ago)
    return {
        "last_24h": float(last_24h),
        "per_hour": last_24h / HOURS_PER_DAY,
        "last_7_days": float(last_7),
        "per_day": last_7 / DAYS_PER_WEEK,
    }


def time_to_merge_stats(durations_hours: list[float]) -> dict[str, float]:
    """Summarize durations (hours) as mean, median, fastest, and slowest."""
    if not durations_hours:
        return {"mean": 0.0, "median": 0.0, "fastest": 0.0, "slowest": 0.0}
    return {
        "mean": _mean(durations_hours),
        "median": _median(durations_hours),
        "fastest": min(durations_hours),
        "slowest": max(durations_hours),
    }


def merge_intervals_hours(merged_at: list[dt.datetime]) -> list[float]:
    """Return the hours between each consecutive pair of merges.

    n merges yield n-1 intervals; fewer than two merges yield an empty list.
    For a sequential loop this approximates how long each tick took end to end.
    """
    ordered = sorted(merged_at)
    return [
        (later - earlier).total_seconds() / SECONDS_PER_HOUR
        for earlier, later in itertools.pairwise(ordered)
    ]


def iteration_stats(per_pr: list[int]) -> dict[str, float]:
    """Summarize review rounds across PRs that reached LGTM.

    ``clean_merge_rate`` is the share of PRs that reached LGTM with zero
    feedback rounds.
    """
    if not per_pr:
        return {
            "mean": 0.0,
            "median": 0.0,
            "max": 0.0,
            "clean_merge_rate": 0.0,
            "sample": 0.0,
        }
    floats = [float(n) for n in per_pr]
    clean = sum(1 for n in per_pr if n == 0)
    return {
        "mean": _mean(floats),
        "median": _median(floats),
        "max": float(max(per_pr)),
        "clean_merge_rate": clean / len(per_pr),
        "sample": float(len(per_pr)),
    }


def estimate_remaining(
    open_items: int, per_day: float, *, now: dt.datetime
) -> dict[str, object]:
    """Project how long the backlog will take at the current merge rate.

    When the rate is zero the estimate is unknown rather than infinite.
    """
    if open_items <= 0:
        return {"open_items": 0, "days_remaining": 0.0, "eta": now, "known": True}
    if per_day <= 0:
        return {
            "open_items": open_items,
            "days_remaining": None,
            "eta": None,
            "known": False,
        }
    days_remaining = open_items / per_day
    return {
        "open_items": open_items,
        "days_remaining": days_remaining,
        "eta": now + dt.timedelta(days=days_remaining),
        "known": True,
    }


def churn_totals(churn: list[tuple[int, int, int]]) -> dict[str, int]:
    """Sum (additions, deletions, changed_files) tuples across merged PRs."""
    additions = sum(c[0] for c in churn)
    deletions = sum(c[1] for c in churn)
    return {
        "additions": additions,
        "deletions": deletions,
        "net": additions - deletions,
        "files": sum(c[2] for c in churn),
    }


def net_lines_from_code_frequency(weeks: list[list[int]]) -> int:
    """Sum GitHub's weekly code-frequency rows into net lines of code.

    Each row is ``[unix_week, additions, deletions]``, with deletions negative.
    """
    return sum(int(week[1]) + int(week[2]) for week in weeks)


def busiest_day(merged_at: list[dt.datetime]) -> tuple[str, int] | None:
    """Return the (ISO date, count) of the day with the most merges, or None."""
    if not merged_at:
        return None
    counter: Counter[str] = Counter(ts.date().isoformat() for ts in merged_at)
    day, count = counter.most_common(1)[0]
    return day, count
