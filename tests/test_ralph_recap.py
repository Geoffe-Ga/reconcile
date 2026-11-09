"""Tests for the Ralph Recap I/O shell (scripts/ralph/recap.py).

Every network call is monkeypatched; nothing here reaches GitHub or Discord.
"""

from __future__ import annotations

import datetime as dt
import json
import urllib.error
from email.message import Message
from typing import Any

import pytest

from scripts.ralph import recap

UTC = dt.UTC
NOW = dt.datetime(2026, 6, 27, 18, tzinfo=UTC)


def _http_error(code: int = 500) -> urllib.error.HTTPError:
    """Build an HTTPError with the given status code."""
    return urllib.error.HTTPError("https://x", code, "err", Message(), None)


def _issue(number: int, *, labels: list[str], is_pr: bool = False) -> dict[str, Any]:
    """Build an issues-endpoint record with the given labels."""
    issue: dict[str, Any] = {
        "number": number,
        "labels": [{"name": name} for name in labels],
    }
    if is_pr:
        issue["pull_request"] = {"url": f"https://example/{number}"}
    return issue


def _hit(number: int, *, merged: str, created: str, title: str = "") -> dict[str, Any]:
    """Build a search hit for a merged PR (with a body that must never leak)."""
    return {
        "number": number,
        "title": title,
        "created_at": created,
        "body": "SECRET BODY TEXT",
        "pull_request": {"merged_at": merged},
    }


# ---------- HTTP helpers ----------


def test_request_json_refuses_non_https() -> None:
    """Request json refuses non https."""
    with pytest.raises(ValueError, match="non-HTTPS"):
        recap._request_json("file:///etc/passwd", headers={})


class _FakeResponse:
    """A stand-in for the urlopen response context manager."""

    def __init__(self, raw: bytes) -> None:
        """Hold the raw response bytes."""
        self._raw = raw

    def __enter__(self) -> _FakeResponse:
        """Enter the context."""
        return self

    def __exit__(self, *_exc: object) -> None:
        """Leave the context without suppressing errors."""
        return None

    def read(self) -> bytes:
        """Return the raw bytes."""
        return self._raw


def test_request_json_parses_body_and_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """Request json parses body and empty."""
    bodies = [b'{"a": 1}', b""]
    monkeypatch.setattr(
        recap.urllib.request,
        "urlopen",
        lambda *_a, **_k: _FakeResponse(bodies.pop(0)),
    )
    assert recap._request_json("https://api.github.com/x", headers={}) == {"a": 1}
    assert recap._request_json("https://api.github.com/x", headers={}) is None


def test_gh_get_paged_follows_full_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gh get paged follows full pages."""
    pages = [[{"n": i} for i in range(100)], [{"n": 100}]]
    urls: list[str] = []

    def fake(url: str, **_k: Any) -> object:
        """Record the call and return the next canned response."""
        urls.append(url)
        return pages.pop(0)

    monkeypatch.setattr(recap, "_request_json", fake)
    out = recap._gh_get_paged("/p", token="t", params={"state": "open"}, max_items=500)
    assert len(out) == 101
    assert "page=1" in urls[0]
    assert "page=2" in urls[1]


def test_gh_get_paged_caps_and_handles_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gh get paged caps and handles empty."""
    monkeypatch.setattr(
        recap, "_request_json", lambda *_a, **_k: [{"n": i} for i in range(100)]
    )
    assert len(recap._gh_get_paged("/p", token="t", params={}, max_items=150)) == 150
    monkeypatch.setattr(recap, "_request_json", lambda *_a, **_k: None)
    assert recap._gh_get_paged("/p", token="t", params={}, max_items=10) == []


def test_gh_search_issues_reads_items(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gh search issues reads items."""
    monkeypatch.setattr(recap, "_request_json", lambda *_a, **_k: {"items": [{"n": 1}]})
    assert recap._gh_search_issues("q", token="t", max_items=10) == [{"n": 1}]


# ---------- GitHub data ----------


def test_count_open_backlog_excludes_prs_and_labelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Count open backlog excludes prs and labelled."""
    monkeypatch.delenv("RALPH_EXCLUDE_LABELS", raising=False)
    issues = [
        _issue(1, labels=[]),
        _issue(2, labels=["client", "P1"]),
        _issue(3, labels=["epic"]),
        _issue(4, labels=["blocked", "relay"]),
        _issue(5, labels=[], is_pr=True),
    ]
    monkeypatch.setattr(recap, "_gh_get_paged", lambda *_a, **_k: issues)
    assert recap.count_open_backlog("o/r", token="t") == 2


def test_count_open_backlog_respects_env_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Count open backlog respects env override."""
    monkeypatch.setenv("RALPH_EXCLUDE_LABELS", "deferred")
    issues = [_issue(1, labels=["epic"]), _issue(2, labels=["deferred"])]
    monkeypatch.setattr(recap, "_gh_get_paged", lambda *_a, **_k: issues)
    assert recap.count_open_backlog("o/r", token="t") == 1


def test_count_merged_total(monkeypatch: pytest.MonkeyPatch) -> None:
    """Count merged total."""
    monkeypatch.setattr(recap, "_request_json", lambda *_a, **_k: {"total_count": 42})
    assert recap.count_merged_total("o/r", token="t") == 42


def test_fetch_recent_merged_prs_sorts_newest_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fetch recent merged prs sorts newest first."""
    hits = [
        _hit(1, merged="2026-06-25T00:00:00Z", created="2026-06-24T00:00:00Z"),
        _hit(2, merged="2026-06-27T00:00:00Z", created="2026-06-26T00:00:00Z"),
        _hit(3, merged="2026-06-26T00:00:00Z", created="2026-06-25T00:00:00Z"),
    ]
    monkeypatch.setattr(recap, "_gh_search_issues", lambda *_a, **_k: hits)
    out = recap.fetch_recent_merged_prs(
        "o/r", token="t", since=dt.date(2026, 6, 20), max_prs=200
    )
    assert [pr["number"] for pr in out] == [2, 3, 1]


def test_fetch_pr_detail(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fetch pr detail."""
    monkeypatch.setattr(recap, "_request_json", lambda url, **_k: {"url": url})
    assert recap.fetch_pr_detail("o/r", 7, token="t")["url"].endswith(
        "/repos/o/r/pulls/7"
    )


def test_pr_churn_reads_counts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pr churn reads counts."""
    monkeypatch.setattr(
        recap,
        "fetch_pr_detail",
        lambda *_a, **_k: {"additions": 12, "deletions": 4, "changed_files": 3},
    )
    assert recap.pr_churn("o/r", 1, token="t") == (12, 4, 3)


def test_pr_churn_degrades_to_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pr churn degrades to zero."""

    def boom(*_a: Any, **_k: Any) -> dict[str, Any]:
        """Raise the injected failure."""
        raise urllib.error.URLError("down")

    monkeypatch.setattr(recap, "fetch_pr_detail", boom)
    assert recap.pr_churn("o/r", 1, token="t") == (0, 0, 0)


def test_fetch_pr_verdicts_keeps_only_verdicts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fetch pr verdicts keeps only verdicts."""
    comments = [
        {"body": "hello"},
        {"body": "## Verdict: CHANGES_REQUESTED"},
        {"body": "## Verdict: LGTM"},
    ]
    monkeypatch.setattr(recap, "_gh_get_paged", lambda *_a, **_k: comments)
    assert recap.fetch_pr_verdicts("o/r", 1, token="t") == ["CHANGES_REQUESTED", "LGTM"]


def _chatter(count: int) -> list[dict[str, Any]]:
    """Build ``count`` comments that carry no verdict line."""
    return [{"body": f"comment {i}"} for i in range(count)]


def test_fetch_pr_verdicts_reads_past_the_first_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A verdict after the first 100 comments is still found."""
    pages = [_chatter(recap.PAGE_SIZE), [{"body": "## Verdict: LGTM"}]]
    urls: list[str] = []

    def fake(url: str, **_k: Any) -> object:
        """Record the call and return the next canned page."""
        urls.append(url)
        return pages.pop(0)

    monkeypatch.setattr(recap, "_request_json", fake)
    assert recap.fetch_pr_verdicts("o/r", 1, token="t") == ["LGTM"]
    assert len(urls) == 2
    assert "page=2" in urls[1]


def test_fetch_pr_verdicts_stops_at_the_comment_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An endless comment thread costs at most ten requests (1,000 comments)."""
    urls: list[str] = []

    def fake(url: str, **_k: Any) -> object:
        """Record the call and return another full page of chatter."""
        urls.append(url)
        return _chatter(recap.PAGE_SIZE)

    monkeypatch.setattr(recap, "_request_json", fake)
    assert recap.fetch_pr_verdicts("o/r", 1, token="t") == []
    assert len(urls) == 10


def test_fetch_repo_net_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fetch repo net lines."""
    monkeypatch.setattr(recap, "_request_json", lambda *_a, **_k: [[1, 100, -40]])
    assert recap.fetch_repo_net_lines("o/r", token="t") == 60


def test_fetch_repo_net_lines_backs_off_until_warm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fetch repo net lines backs off until warm."""
    responses: list[object] = [None, None, [[0, 10, -3]]]
    monkeypatch.setattr(recap, "_request_json", lambda *_a, **_k: responses.pop(0))
    slept: list[float] = []
    assert recap.fetch_repo_net_lines("o/r", token="t", sleep=slept.append) == 7
    assert slept == [2.0, 4.0]


def test_fetch_repo_net_lines_none_when_cold_or_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fetch repo net lines none when cold or error."""
    monkeypatch.setattr(recap, "_request_json", lambda *_a, **_k: None)
    slept: list[float] = []
    assert (
        recap.fetch_repo_net_lines("o/r", token="t", attempts=2, sleep=slept.append)
        is None
    )
    assert slept == [2.0]

    def boom(*_a: Any, **_k: Any) -> object:
        """Raise the injected failure."""
        raise _http_error()

    monkeypatch.setattr(recap, "_request_json", boom)
    assert recap.fetch_repo_net_lines("o/r", token="t") is None


def test_fetch_repo_net_lines_empty_list_is_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fetch repo net lines empty list is zero."""
    monkeypatch.setattr(recap, "_request_json", lambda *_a, **_k: [])
    assert recap.fetch_repo_net_lines("o/r", token="t") == 0


# ---------- formatting ----------


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("feat(relay): add mailbox storage", "add mailbox storage"),
        ("fix!: drop IPs", "drop IPs"),
        ("docs: record decisions", "record decisions"),
        ("Note: not a prefix", "Note: not a prefix"),
        ("one two three four five six seven eight nine ten eleven", None),
        ("   ", "Another change merged"),
    ],
)
def test_headline_from_title(title: str, expected: str | None) -> None:
    """Headline from title."""
    result = recap.headline_from_title(title)
    if expected is None:
        assert len(result.split()) == 10
        assert result.endswith("ten")
    else:
        assert result == expected


@pytest.mark.parametrize(
    ("hours", "expected"),
    [(0.5, "30m"), (1.0, "1.0h"), (47.9, "47.9h"), (48.0, "2.0d")],
)
def test_fmt_hours(hours: float, expected: str) -> None:
    """Fmt hours."""
    assert recap.fmt_hours(hours) == expected


def test_fmt_eta_variants() -> None:
    """Fmt eta variants."""
    assert recap.fmt_eta({"known": False}).startswith("unknown")
    assert recap.fmt_eta({"known": True, "days_remaining": 0.0}) == "backlog clear"
    eta = {"known": True, "days_remaining": 2.5, "eta": NOW}
    assert recap.fmt_eta(eta) == "~2.5 days (about 2026-06-27)"


def test_open_to_merge_hours_and_clamp() -> None:
    """Open to merge hours and clamp."""
    pr = _hit(1, merged="2026-06-27T12:00:00Z", created="2026-06-27T10:00:00Z")
    assert recap.open_to_merge_hours(pr) == 2.0
    skewed = _hit(1, merged="2026-06-27T10:00:00Z", created="2026-06-27T12:00:00Z")
    assert recap.open_to_merge_hours(skewed) == 0.0


def test_stat_line() -> None:
    """Stat line."""
    assert recap.stat_line({"median": 0, "fastest": 0, "slowest": 0}).startswith("not")
    line = recap.stat_line({"median": 2.0, "fastest": 0.5, "slowest": 50.0})
    assert line == "median **2.0h** · fastest 30m · slowest 2.1d"


def test_this_pr_lines() -> None:
    """This pr lines."""
    assert recap.this_pr_tick_line(None) == "first tracked merge"
    assert recap.this_pr_tick_line(3.0) == "**3.0h** since the previous merge"
    assert recap.this_pr_iter_line(None) == "merged without an LGTM verdict"
    assert recap.this_pr_iter_line(0) == "**0** rounds · clean first try"
    assert recap.this_pr_iter_line(1) == "**1** round to LGTM"
    assert recap.this_pr_iter_line(2) == "**2** rounds to LGTM"


def test_loc_line() -> None:
    """Loc line."""
    small = {"additions": 1, "deletions": 2}
    big = {"additions": 1500, "deletions": 20}
    assert recap.loc_line(small, big, 0) == (
        "+1 / -2 (24h) · +1,500 / -20 (7d) · 0 net (full repo)"
    )
    assert recap.loc_line(small, big, None).endswith("— (full repo)")


def test_iter_summary_line() -> None:
    """Iter summary line."""
    assert recap.iter_summary_line({"sample": 0.0}).startswith("no LGTM")
    line = recap.iter_summary_line(
        {"mean": 1.0, "clean_merge_rate": 0.5, "max": 3.0, "sample": 4.0}
    )
    assert (
        line
        == "**1.0** avg rounds to LGTM · **50%** first-try clean · worst **3** (n=4)"
    )


# ---------- assembly ----------


def _patch_history(
    monkeypatch: pytest.MonkeyPatch, window: list[dict[str, Any]]
) -> None:
    """Replace every GitHub call build_recap makes with canned data."""
    monkeypatch.setattr(recap, "fetch_recent_merged_prs", lambda *_a, **_k: window)
    monkeypatch.setattr(recap, "count_merged_total", lambda *_a, **_k: 9)
    monkeypatch.setattr(recap, "count_open_backlog", lambda *_a, **_k: 4)
    monkeypatch.setattr(recap, "fetch_repo_net_lines", lambda *_a, **_k: 1234)
    verdicts = {1: ["CHANGES_REQUESTED", "LGTM"], 2: ["LGTM"], 3: ["COMMENTS"]}
    monkeypatch.setattr(
        recap, "fetch_pr_verdicts", lambda _repo, number, **_k: verdicts[number]
    )
    monkeypatch.setattr(recap, "pr_churn", lambda _repo, number, **_k: (number, 1, 1))


def test_build_recap_none_without_merges(monkeypatch: pytest.MonkeyPatch) -> None:
    """Build recap none without merges."""
    _patch_history(monkeypatch, [])
    assert recap.build_recap("o/r", token="t", max_prs=10, now=NOW) is None


def test_build_recap_renders_metadata_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """Build recap renders metadata only."""
    window = [
        _hit(
            1,
            merged="2026-06-27T12:00:00Z",
            created="2026-06-27T10:00:00Z",
            title="feat(relay): add mailbox storage",
        ),
        _hit(2, merged="2026-06-27T09:00:00Z", created="2026-06-27T08:00:00Z"),
        _hit(3, merged="2026-06-21T09:00:00Z", created="2026-06-21T08:00:00Z"),
    ]
    _patch_history(monkeypatch, window)
    payload = recap.build_recap("o/r", token="t", max_prs=10, now=NOW)
    assert payload is not None
    assert "SECRET BODY TEXT" not in json.dumps(payload)
    embed = payload["embeds"][0]
    assert embed["title"] == "Ralph Recap — o/r"
    fields = {f["name"]: f["value"] for f in embed["fields"]}
    expected = {
        "Unlock": "*add mailbox storage*",
        "Link": "[#1 — feat(relay): add mailbox storage](https://github.com/o/r/pull/1)",
        "Review iterations": "**1** round to LGTM",
        "Tick length": "**3.0h** since the previous merge",
        "Time for review": "**2.0h** open → merge",
        "Footprint": "+1 / -1 across 1 file(s)",
        "PRs merged": "2 in 24h · 3 in 7d · **9** all-time",
        "LoC": "+3 / -2 (24h) · +6 / -3 (7d) · 1,234 net (full repo)",
        "Busiest day (7d)": "2 merges on 2026-06-27",
        "Backlog remaining": "**4** open · ETA ~9.3 days (about 2026-07-07)",
    }
    assert {name: fields[name] for name in expected} == expected
    assert embed["footer"]["text"] == "Ralph Recap · posts on every merge"


def test_build_recap_blocks_every_mention(monkeypatch: pytest.MonkeyPatch) -> None:
    """A PR title with @everyone, @here, or a role mention can never ping anyone."""
    title = "fix: @everyone @here <@&123> <@456> look"
    window = [
        _hit(
            1,
            merged="2026-06-27T12:00:00Z",
            created="2026-06-27T10:00:00Z",
            title=title,
        )
    ]
    _patch_history(monkeypatch, window)
    payload = recap.build_recap("o/r", token="t", max_prs=10, now=NOW)
    assert payload is not None
    assert payload["allowed_mentions"] == {"parse": []}
    assert title in json.dumps(payload, ensure_ascii=False)


def _busy_window(count: int) -> list[dict[str, Any]]:
    """``count`` merges, newest first, half an hour apart, all inside 7 days."""
    hits: list[dict[str, Any]] = []
    for number in range(1, count + 1):
        merged = NOW - dt.timedelta(minutes=30 * number)
        opened = merged - dt.timedelta(hours=1)
        hits.append(_hit(number, merged=merged.isoformat(), created=opened.isoformat()))
    return hits


def _record_detail_calls(
    monkeypatch: pytest.MonkeyPatch, window: list[dict[str, Any]]
) -> list[tuple[str, int]]:
    """Patch the history and record every per-PR API call build_recap makes."""
    _patch_history(monkeypatch, window)
    calls: list[tuple[str, int]] = []

    def verdicts(_repo: str, number: int, **_k: Any) -> list[str]:
        """Record a verdict lookup; every PR passed on the first try."""
        calls.append(("verdicts", number))
        return ["LGTM"]

    def churn(_repo: str, number: int, **_k: Any) -> tuple[int, int, int]:
        """Record a diff-count lookup."""
        calls.append(("churn", number))
        return (number, 1, 1)

    monkeypatch.setattr(recap, "fetch_pr_verdicts", verdicts)
    monkeypatch.setattr(recap, "pr_churn", churn)
    return calls


def test_build_recap_bounds_per_pr_calls_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 200-PR window makes per-PR calls for the newest 50 merges only."""
    calls = _record_detail_calls(monkeypatch, _busy_window(200))
    payload = recap.build_recap("o/r", token="t", max_prs=200, now=NOW)
    assert payload is not None
    assert len(calls) == 100
    assert {number for _kind, number in calls} == set(range(1, 51))


def test_build_recap_says_when_detail_is_capped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Capped figures cover the newest merges, and the footer says so."""
    _record_detail_calls(monkeypatch, _busy_window(5))
    payload = recap.build_recap("o/r", token="t", max_prs=10, now=NOW, max_detail_prs=2)
    assert payload is not None
    embed = payload["embeds"][0]
    fields = {f["name"]: f["value"] for f in embed["fields"]}
    assert fields["PRs merged"] == "5 in 24h · 5 in 7d · **9** all-time"
    assert fields["LoC"] == "+3 / -2 (24h) · +3 / -2 (7d) · 1,234 net (full repo)"
    assert fields["Review iterations (7d)"].endswith("(n=2)")
    assert embed["footer"]["text"] == (
        "Ralph Recap · posts on every merge · "
        "LoC and review iterations cover the newest 2 of 5 merges"
    )


def test_build_recap_always_details_the_latest_pr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even a zero cap still reads the just-merged PR's rounds and footprint."""
    calls = _record_detail_calls(monkeypatch, _busy_window(3))
    payload = recap.build_recap("o/r", token="t", max_prs=10, now=NOW, max_detail_prs=0)
    assert payload is not None
    assert calls == [("verdicts", 1), ("churn", 1)]
    fields = {f["name"]: f["value"] for f in payload["embeds"][0]["fields"]}
    assert fields["Review iterations"] == "**0** rounds · clean first try"
    assert fields["Footprint"] == "+1 / -1 across 1 file(s)"


def test_build_recap_single_merge(monkeypatch: pytest.MonkeyPatch) -> None:
    """Build recap single merge."""
    window = [_hit(2, merged="2026-06-27T12:00:00Z", created="2026-06-27T11:00:00Z")]
    _patch_history(monkeypatch, window)
    payload = recap.build_recap("o/r", token="t", max_prs=10, now=NOW)
    assert payload is not None
    fields = {f["name"]: f["value"] for f in payload["embeds"][0]["fields"]}
    expected = {
        "Tick length": "first tracked merge",
        "Review iterations": "**0** rounds · clean first try",
        "Unlock": "*Another change merged*",
    }
    assert {name: fields[name] for name in expected} == expected


# ---------- delivery and CLI ----------


def test_post_to_discord_sends_bot_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    """Post to discord sends bot auth."""
    seen: dict[str, Any] = {}

    def fake(url: str, **kwargs: Any) -> object:
        """Record the call and return the next canned response."""
        seen["url"] = url
        seen.update(kwargs)
        return None

    monkeypatch.setattr(recap, "_request_json", fake)
    recap.post_to_discord("123", "tok", {"embeds": []})
    assert seen["url"].endswith("/channels/123/messages")
    assert seen["headers"]["Authorization"] == "Bot tok"
    assert seen["method"] == "POST"
    assert json.loads(seen["body"]) == {"embeds": []}


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """Clear every setting the recap reads from the environment."""
    for name in (
        "DISCORD_BOT_TOKEN",
        "RALPH_CHANNEL_ID",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_REPOSITORY",
    ):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_main_skips_cleanly_when_unconfigured(
    clean_env: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Main skips cleanly when unconfigured."""
    assert recap.main(["--repo", "o/r", "--skip-if-unconfigured"]) == 0
    assert "::notice::Ralph Recap skipped" in capsys.readouterr().out


def test_main_errors_when_unconfigured_without_skip(
    clean_env: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Main errors when unconfigured without skip."""
    assert recap.main(["--repo", "o/r"]) == 2
    assert "DISCORD_BOT_TOKEN" in capsys.readouterr().err


def test_main_requires_repo_and_token(
    clean_env: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Main requires repo and token."""
    assert recap.main(["--dry-run"]) == 2
    assert recap.main(["--dry-run", "--repo", "o/r"]) == 2
    err = capsys.readouterr().err
    assert "--repo" in err
    assert "GITHUB_TOKEN" in err


def test_main_dry_run_prints_payload(
    clean_env: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Main dry run prints payload."""
    clean_env.setenv("GH_TOKEN", "t")
    clean_env.setattr(recap, "build_recap", lambda *_a, **_k: {"embeds": ["x"]})
    assert recap.main(["--repo", "o/r", "--dry-run"]) == 0
    assert json.loads(capsys.readouterr().out) == {"embeds": ["x"]}


def test_main_passes_the_detail_cap(
    clean_env: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """--max-detail-prs reaches build_recap, defaulting to 50."""
    clean_env.setenv("GITHUB_TOKEN", "t")
    caps: list[int] = []

    def fake(*_a: Any, **kwargs: Any) -> None:
        """Record the detail cap and report nothing to recap."""
        caps.append(kwargs["max_detail_prs"])

    clean_env.setattr(recap, "build_recap", fake)
    assert recap.main(["--repo", "o/r", "--dry-run"]) == 0
    assert recap.main(["--repo", "o/r", "--dry-run", "--max-detail-prs", "5"]) == 0
    assert caps == [50, 5]
    assert "nothing to recap" in capsys.readouterr().out


def test_main_nothing_to_recap(
    clean_env: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Main nothing to recap."""
    clean_env.setenv("GITHUB_TOKEN", "t")
    clean_env.setattr(recap, "build_recap", lambda *_a, **_k: None)
    assert recap.main(["--repo", "o/r", "--dry-run"]) == 0
    assert "nothing to recap" in capsys.readouterr().out


def test_main_posts_when_configured(
    clean_env: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Main posts when configured."""
    clean_env.setenv("GITHUB_TOKEN", "t")
    clean_env.setenv("DISCORD_BOT_TOKEN", "bot")
    clean_env.setenv("RALPH_CHANNEL_ID", "123")
    clean_env.setattr(recap, "build_recap", lambda *_a, **_k: {"embeds": []})
    posted: list[tuple[str, str]] = []
    clean_env.setattr(
        recap, "post_to_discord", lambda cid, tok, _p: posted.append((cid, tok))
    )
    assert recap.main(["--repo", "o/r"]) == 0
    assert posted == [("123", "bot")]
    assert "Posted" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("error", "fragment"),
    [(_http_error(503), "503"), (urllib.error.URLError("dns"), "network failure")],
)
def test_main_maps_github_failures(
    clean_env: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    error: Exception,
    fragment: str,
) -> None:
    """Main maps github failures."""
    clean_env.setenv("GITHUB_TOKEN", "t")

    def boom(*_a: Any, **_k: Any) -> dict[str, Any]:
        """Raise the injected failure."""
        raise error

    clean_env.setattr(recap, "build_recap", boom)
    assert recap.main(["--repo", "o/r", "--dry-run"]) == 1
    err = capsys.readouterr().err
    assert "GitHub" in err
    assert fragment in err


@pytest.mark.parametrize(
    ("error", "fragment"),
    [(_http_error(403), "403"), (urllib.error.URLError("dns"), "network failure")],
)
def test_main_maps_discord_failures(
    clean_env: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    error: Exception,
    fragment: str,
) -> None:
    """Main maps discord failures."""
    clean_env.setenv("GITHUB_TOKEN", "t")
    clean_env.setenv("DISCORD_BOT_TOKEN", "bot")
    clean_env.setenv("RALPH_CHANNEL_ID", "123")
    clean_env.setattr(recap, "build_recap", lambda *_a, **_k: {"embeds": []})

    def boom(*_a: Any, **_k: Any) -> None:
        """Raise the injected failure."""
        raise error

    clean_env.setattr(recap, "post_to_discord", boom)
    assert recap.main(["--repo", "o/r"]) == 1
    err = capsys.readouterr().err
    assert "Discord" in err
    assert fragment in err
