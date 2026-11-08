"""Tests for the Ralph Recap's pure statistics helpers (scripts/ralph/stats.py)."""

from __future__ import annotations

import datetime as dt

import pytest

from scripts.ralph import stats

UTC = dt.UTC


def _at(day: int, hour: int = 12) -> dt.datetime:
    """A UTC datetime on 2026-06-<day> at the given hour."""
    return dt.datetime(2026, 6, day, hour, tzinfo=UTC)


def test_parse_iso_handles_trailing_z() -> None:
    """Parse iso handles trailing z."""
    assert stats.parse_iso("2026-06-27T12:30:00Z") == dt.datetime(
        2026, 6, 27, 12, 30, tzinfo=UTC
    )


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("No verdict here.", None),
        ("## Verdict: LGTM", "LGTM"),
        ("Looks fine.\n\n## Verdict: COMMENTS", "COMMENTS"),
        ("**Verdict:** CHANGES_REQUESTED", "CHANGES_REQUESTED"),
        ("Verdict: changes requested", "CHANGES_REQUESTED"),
        ("verdict: lgtm", "LGTM"),
        ("Not yet LGTM, see below.\n## Verdict: COMMENTS", "COMMENTS"),
        ("We said the verdict: LGTM would come later.", None),
        ("> ## Verdict: CHANGES_REQUESTED\n## Verdict: LGTM", "LGTM"),
        ("## Verdict: CHANGES_REQUESTED\nlater\n## Verdict: LGTM", "LGTM"),
    ],
)
def test_normalize_verdict(body: str, expected: str | None) -> None:
    """Normalize verdict."""
    assert stats.normalize_verdict(body) == expected


def test_iterations_before_lgtm_counts_rounds() -> None:
    """Iterations before lgtm counts rounds."""
    assert stats.iterations_before_lgtm(["CHANGES_REQUESTED", "COMMENTS", "LGTM"]) == 2


def test_iterations_before_lgtm_zero_for_clean_merge() -> None:
    """Iterations before lgtm zero for clean merge."""
    assert stats.iterations_before_lgtm(["LGTM", "CHANGES_REQUESTED"]) == 0


def test_iterations_before_lgtm_none_when_never_lgtm() -> None:
    """Iterations before lgtm none when never lgtm."""
    assert stats.iterations_before_lgtm(["COMMENTS"]) is None
    assert stats.iterations_before_lgtm([]) is None


def test_merge_rate_empty() -> None:
    """Merge rate empty."""
    assert stats.merge_rate([], now=_at(27)) == {
        "last_24h": 0.0,
        "per_hour": 0.0,
        "last_7_days": 0.0,
        "per_day": 0.0,
    }


def test_merge_rate_windows() -> None:
    """Merge rate windows."""
    now = _at(27)
    merges = [_at(27, 6), _at(26, 13), _at(26, 11), _at(22), _at(19)]
    rate = stats.merge_rate(merges, now=now)
    assert rate["last_24h"] == 2.0
    assert rate["per_hour"] == pytest.approx(2 / 24)
    assert rate["last_7_days"] == 4.0
    assert rate["per_day"] == pytest.approx(4 / 7)


def test_merge_rate_window_edges_are_inclusive() -> None:
    """Merge rate window edges are inclusive."""
    now = _at(27)
    rate = stats.merge_rate([_at(26), _at(20)], now=now)
    assert rate["last_24h"] == 1.0
    assert rate["last_7_days"] == 2.0


def test_time_to_merge_stats_odd_and_even() -> None:
    """Time to merge stats odd and even."""
    assert stats.time_to_merge_stats([3.0, 1.0, 2.0]) == {
        "mean": 2.0,
        "median": 2.0,
        "fastest": 1.0,
        "slowest": 3.0,
    }
    assert stats.time_to_merge_stats([1.0, 2.0, 3.0, 10.0])["median"] == 2.5


def test_time_to_merge_stats_empty() -> None:
    """Time to merge stats empty."""
    assert stats.time_to_merge_stats([]) == {
        "mean": 0.0,
        "median": 0.0,
        "fastest": 0.0,
        "slowest": 0.0,
    }


def test_merge_intervals_hours_sorts_then_diffs() -> None:
    """Merge intervals hours sorts then diffs."""
    assert stats.merge_intervals_hours([_at(27, 15), _at(27, 12), _at(27, 13)]) == [
        1.0,
        2.0,
    ]


def test_merge_intervals_hours_empty_below_two_merges() -> None:
    """Merge intervals hours empty below two merges."""
    assert stats.merge_intervals_hours([_at(27)]) == []
    assert stats.merge_intervals_hours([]) == []


def test_iteration_stats() -> None:
    """Iteration stats."""
    result = stats.iteration_stats([0, 0, 1, 3])
    assert result == {
        "mean": 1.0,
        "median": 0.5,
        "max": 3.0,
        "clean_merge_rate": 0.5,
        "sample": 4.0,
    }


def test_iteration_stats_empty() -> None:
    """Iteration stats empty."""
    assert stats.iteration_stats([])["sample"] == 0.0


def test_median_of_empty_is_zero() -> None:
    """Median of empty is zero."""
    assert stats._median([]) == 0.0


def test_estimate_remaining_projects_eta() -> None:
    """Estimate remaining projects eta."""
    now = _at(1)
    result = stats.estimate_remaining(10, 2.0, now=now)
    assert result == {
        "open_items": 10,
        "days_remaining": 5.0,
        "eta": _at(6),
        "known": True,
    }


def test_estimate_remaining_unknown_when_rate_zero() -> None:
    """Estimate remaining unknown when rate zero."""
    result = stats.estimate_remaining(4, 0.0, now=_at(1))
    assert result["known"] is False
    assert result["eta"] is None


def test_estimate_remaining_clear_backlog() -> None:
    """Estimate remaining clear backlog."""
    now = _at(1)
    assert stats.estimate_remaining(0, 3.0, now=now) == {
        "open_items": 0,
        "days_remaining": 0.0,
        "eta": now,
        "known": True,
    }


def test_churn_totals() -> None:
    """Churn totals."""
    assert stats.churn_totals([(10, 4, 2), (5, 7, 1)]) == {
        "additions": 15,
        "deletions": 11,
        "net": 4,
        "files": 3,
    }


def test_net_lines_from_code_frequency() -> None:
    """Net lines from code frequency."""
    assert stats.net_lines_from_code_frequency([[1, 100, -40], [2, 20, -5]]) == 75
    assert stats.net_lines_from_code_frequency([]) == 0


def test_busiest_day() -> None:
    """Busiest day."""
    merges = [_at(26, 9), _at(27, 9), _at(27, 10)]
    assert stats.busiest_day(merges) == ("2026-06-27", 2)
    assert stats.busiest_day([]) is None
