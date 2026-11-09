"""Post a Ralph Recap to Discord whenever a pull request merges.

Delivery reads two settings from the environment:

    DISCORD_BOT_TOKEN   Bot token (sent as ``Authorization: Bot <token>``).
    RALPH_CHANNEL_ID    Snowflake ID of the channel to post into.

A GitHub token (``GITHUB_TOKEN`` or ``GH_TOKEN``) and the repo slug (``--repo``
or ``$GITHUB_REPOSITORY``) are used to read the merge history.

Privacy: this repo is private and its threat model treats project content as
sensitive. The recap posts **merge metadata only**: PR number, title, link,
counts, durations, and review-round numbers. It never reads or posts PR bodies,
diffs, file names, or file contents, and it calls no AI service. The headline
is the PR title with its conventional-commit prefix removed.

Run it from ``.github/workflows/ralph-recap.yml`` or locally:

    GITHUB_TOKEN="$(gh auth token)" \\
        python -m scripts.ralph.recap --repo OWNER/REPO --dry-run

``--dry-run`` prints the embed as JSON instead of posting it.
``--max-prs`` caps the 7-day window (default 200). ``--max-detail-prs`` caps
how many of its newest PRs get per-PR API calls for review verdicts and diff
counts (default 50), which keeps a run inside the token's hourly budget.
``--skip-if-unconfigured`` exits 0 with a notice when the Discord settings are
absent, so the workflow stays green until the secrets exist. Ported from the
adepthood repository; the statistics live in ``stats.py``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING, Any, ClassVar, cast

from scripts.ralph import stats

if TYPE_CHECKING:
    from collections.abc import Callable


class RecapError(Exception):
    """A user-facing failure with an associated process exit code."""

    def __init__(self, message: str, code: int = 1) -> None:
        """Store the message and the exit code the CLI should return."""
        super().__init__(message)
        self.code = code


class MissingSettingError(RecapError):
    """A required setting (flag or environment variable) is absent; exit 2."""

    SETTINGS: ClassVar[dict[str, str]] = {
        "discord": "DISCORD_BOT_TOKEN and RALPH_CHANNEL_ID",
        "repo": "--repo or $GITHUB_REPOSITORY",
        "github-token": "GITHUB_TOKEN (or GH_TOKEN)",
    }

    def __init__(self, key: str) -> None:
        """Name the missing setting, looked up by ``key``, in the message."""
        super().__init__(f"{self.SETTINGS[key]} is required", code=2)


class ServiceError(RecapError):
    """A GitHub or Discord request failed; exit 1."""

    def __init__(self, service: str, exc: urllib.error.URLError) -> None:
        """Describe an HTTP status failure or a transport failure."""
        if isinstance(exc, urllib.error.HTTPError):
            message = f"{service} API request failed: {exc.code} {exc.reason}"
        else:
            message = f"network failure talking to {service}: {exc.reason}"
        super().__init__(message)


class InsecureURLError(ValueError):
    """A request URL that isn't HTTPS."""

    def __init__(self, url: str) -> None:
        """Name the refused URL in the message."""
        super().__init__(f"refusing non-HTTPS URL: {url}")


GITHUB_API = "https://api.github.com"
DISCORD_API = "https://discord.com/api/v10"
HTTP_TIMEOUT_SECONDS = 30
PAGE_SIZE = 100
# Comments read per PR when looking for verdicts: ten pages at most. Paging
# stops at the first short page, so a typical PR still costs one request.
MAX_COMMENTS_PER_PR = 1000
EMBED_COLOR = 0x7C3AED
# Zero-width space: a non-empty Discord field value that renders as blank.
BLANK = "​"
_RULE = "—" * 4
THIS_PR_HEADER = f"{_RULE}THIS PR{_RULE}"
LOOP_HEADER = f"{_RULE}THE LOOP{_RULE}"
RECENT_WINDOW_DAYS = 7
DEFAULT_MAX_PRS = 200
# Per-PR detail (verdicts and diff counts) costs about two REST requests per PR,
# so only the newest merges get it. Fifty keeps a typical run near 110 requests
# (a full 200-PR window would cost about 400), well inside the Actions
# GITHUB_TOKEN's budget of 1,000 per hour per repository.
DEFAULT_MAX_DETAIL_PRS = 50
FOOTER = "Ralph Recap · posts on every merge"
HEADLINE_WORDS = 10
MINUTES_PER_HOUR = 60
HOURS_SHOWN_AS_HOURS = 48
CONVENTIONAL_PREFIXES = (
    "feat",
    "fix",
    "chore",
    "refactor",
    "docs",
    "test",
    "ci",
    "build",
    "perf",
    "style",
    "process",
)

# Issues with any of these labels aren't real backlog work, so they're left out
# of the open-issue count behind the ETA (ADR-0060 label scheme).
DEFAULT_EXCLUDE_LABELS = (
    "epic",
    "blocked",
    "wontfix",
    "duplicate",
    "invalid",
    "question",
)


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #


def _request_json(
    url: str,
    *,
    headers: dict[str, str],
    method: str = "GET",
    body: bytes | None = None,
) -> object:
    """Perform an HTTPS request and parse the JSON response body.

    Only ``https://`` URLs are accepted. Raises ``urllib.error.HTTPError`` or
    ``URLError`` on transport or HTTP failures, and ``ValueError`` on any other
    scheme.
    """
    if not url.startswith("https://"):
        raise InsecureURLError(url)
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    # The scheme is checked above, so file:// and custom schemes can't reach this.
    with urllib.request.urlopen(  # nosec B310 - HTTPS-only, enforced above
        request, timeout=HTTP_TIMEOUT_SECONDS
    ) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else None


def _gh_headers(token: str) -> dict[str, str]:
    """Headers for an authenticated GitHub REST API call."""
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ralph-recap",
    }


def _paged(
    fetch_page: Callable[[int], list[dict[str, Any]]], max_items: int
) -> list[dict[str, Any]]:
    """Collect pages from ``fetch_page`` until a short page or ``max_items``."""
    out: list[dict[str, Any]] = []
    page = 1
    while len(out) < max_items:
        chunk = fetch_page(page)
        out.extend(chunk)
        if len(chunk) < PAGE_SIZE:
            break
        page += 1
    return out[:max_items]


def _gh_get_paged(
    path: str, *, token: str, params: dict[str, str], max_items: int
) -> list[dict[str, Any]]:
    """GET a paginated GitHub list endpoint, stopping at ``max_items``."""

    def fetch_page(page: int) -> list[dict[str, Any]]:
        """Fetch one page of the list endpoint."""
        query = urllib.parse.urlencode(
            {**params, "per_page": str(PAGE_SIZE), "page": str(page)}
        )
        url = f"{GITHUB_API}{path}?{query}"
        data = _request_json(url, headers=_gh_headers(token))
        return cast("list[dict[str, Any]]", data or [])

    return _paged(fetch_page, max_items)


def _gh_search_issues(
    query: str, *, token: str, max_items: int
) -> list[dict[str, Any]]:
    """Run a GitHub issue/PR search, paging up to ``max_items`` results."""

    def fetch_page(page: int) -> list[dict[str, Any]]:
        """Fetch one page of search results."""
        qs = urllib.parse.urlencode(
            {"q": query, "per_page": str(PAGE_SIZE), "page": str(page)}
        )
        data = cast(
            "dict[str, Any]",
            _request_json(
                f"{GITHUB_API}/search/issues?{qs}", headers=_gh_headers(token)
            ),
        )
        return cast("list[dict[str, Any]]", data.get("items", []))

    return _paged(fetch_page, max_items)


# --------------------------------------------------------------------------- #
# GitHub data gathering
# --------------------------------------------------------------------------- #


def count_merged_total(repo: str, *, token: str) -> int:
    """Return the all-time count of merged PRs via the search API."""
    qs = urllib.parse.urlencode({"q": f"repo:{repo} is:pr is:merged", "per_page": "1"})
    data = cast(
        "dict[str, Any]",
        _request_json(f"{GITHUB_API}/search/issues?{qs}", headers=_gh_headers(token)),
    )
    return int(data.get("total_count", 0))


def fetch_recent_merged_prs(
    repo: str, *, token: str, since: dt.date, max_prs: int
) -> list[dict[str, Any]]:
    """Return PRs merged on or after ``since``, newest merge first."""
    query = f"repo:{repo} is:pr is:merged merged:>={since.isoformat()}"
    items = _gh_search_issues(query, token=token, max_items=max_prs)
    items.sort(key=lambda it: str(it["pull_request"]["merged_at"]), reverse=True)
    return items


def fetch_pr_detail(repo: str, number: int, *, token: str) -> dict[str, Any]:
    """Fetch one PR's detail record (carries the diff-size counts)."""
    url = f"{GITHUB_API}/repos/{repo}/pulls/{number}"
    return cast("dict[str, Any]", _request_json(url, headers=_gh_headers(token)))


def pr_churn(repo: str, number: int, *, token: str) -> tuple[int, int, int]:
    """Return one PR's (additions, deletions, changed_files) counts.

    Only the three counts are read from the detail record. A transport failure
    degrades to zeros rather than failing the whole recap.
    """
    try:
        detail = fetch_pr_detail(repo, number, token=token)
    except (urllib.error.HTTPError, urllib.error.URLError):
        return (0, 0, 0)
    return (
        int(detail.get("additions", 0)),
        int(detail.get("deletions", 0)),
        int(detail.get("changed_files", 0)),
    )


def fetch_pr_verdicts(repo: str, number: int, *, token: str) -> list[str]:
    """Return the ordered list of normalized review verdicts on one PR.

    Reads up to ``MAX_COMMENTS_PER_PR`` comments, oldest first, so a verdict
    posted after a long discussion is still found. Comment bodies are parsed
    for the verdict line and then discarded; none of their text is kept or
    posted.
    """
    comments = _gh_get_paged(
        f"/repos/{repo}/issues/{number}/comments",
        token=token,
        params={"sort": "created", "direction": "asc"},
        max_items=MAX_COMMENTS_PER_PR,
    )
    verdicts = (stats.normalize_verdict(str(c.get("body", ""))) for c in comments)
    return [v for v in verdicts if v is not None]


def fetch_repo_net_lines(
    repo: str,
    *,
    token: str,
    attempts: int = 4,
    sleep: Callable[[float], None] = time.sleep,
) -> int | None:
    """Return the repo's net lines of code from the code-frequency stats API.

    GitHub computes these stats asynchronously and answers 202 with an empty
    body on a cold cache, which ``_request_json`` returns as None. Retries back
    off exponentially (2s, 4s, 8s). A genuine empty list means 0 net. A still
    cold cache or a transport error returns None, shown as a dash.
    """
    url = f"{GITHUB_API}/repos/{repo}/stats/code_frequency"
    for attempt in range(attempts):
        try:
            data = _request_json(url, headers=_gh_headers(token))
        except (urllib.error.HTTPError, urllib.error.URLError):
            return None
        if data is not None:
            return stats.net_lines_from_code_frequency(cast("list[list[int]]", data))
        if attempt < attempts - 1:
            sleep(2.0 * (2**attempt))
    return None


def _excluded_labels() -> set[str]:
    """Labels that disqualify an issue from the backlog count.

    Override with ``RALPH_EXCLUDE_LABELS`` (space-separated); an empty value
    counts every open issue.
    """
    raw = os.environ.get("RALPH_EXCLUDE_LABELS")
    if raw is None:
        return set(DEFAULT_EXCLUDE_LABELS)
    return {label for label in raw.split() if label}


def count_open_backlog(repo: str, *, token: str, max_items: int = 1000) -> int:
    """Count open issues that are real backlog work (PRs and excluded labels out)."""
    issues = _gh_get_paged(
        f"/repos/{repo}/issues",
        token=token,
        params={"state": "open"},
        max_items=max_items,
    )
    excluded = _excluded_labels()
    backlog = 0
    for issue in issues:
        names = {str(label.get("name", "")) for label in issue.get("labels", [])}
        if "pull_request" not in issue and not names & excluded:
            backlog += 1
    return backlog


# --------------------------------------------------------------------------- #
# Formatting
# --------------------------------------------------------------------------- #


def headline_from_title(title: str) -> str:
    """Turn a PR title into a short headline, at most ten words.

    Strips a conventional-commit prefix such as ``feat(relay):``. No AI service
    is called, so no project text leaves GitHub beyond the title itself.
    """
    cleaned = title.strip()
    head, sep, rest = cleaned.partition(":")
    kind = head.split("(", 1)[0].rstrip("!").strip().lower()
    if sep and kind in CONVENTIONAL_PREFIXES:
        cleaned = rest.strip()
    words = cleaned.split()
    return " ".join(words[:HEADLINE_WORDS]) if words else "Another change merged"


def fmt_hours(hours: float) -> str:
    """Render a duration as minutes, hours, or days."""
    if hours < 1:
        return f"{round(hours * MINUTES_PER_HOUR)}m"
    if hours < HOURS_SHOWN_AS_HOURS:
        return f"{hours:.1f}h"
    return f"{hours / stats.HOURS_PER_DAY:.1f}d"


def fmt_eta(estimate: dict[str, object]) -> str:
    """Render a backlog estimate as a sentence fragment."""
    if not estimate["known"]:
        return "unknown (no recent merges)"
    days = cast("float | None", estimate["days_remaining"])
    if days is None or days <= 0:
        return "backlog clear"
    eta = cast("dt.datetime", estimate["eta"])
    return f"~{days:.1f} days (about {eta.date().isoformat()})"


def pr_merged_at(pr: dict[str, Any]) -> dt.datetime:
    """Parse a search hit's merge timestamp."""
    return stats.parse_iso(str(pr["pull_request"]["merged_at"]))


def open_to_merge_hours(pr: dict[str, Any]) -> float:
    """Hours from a PR opening to its merge, clamped at zero for clock skew."""
    opened = stats.parse_iso(str(pr["created_at"]))
    seconds = (pr_merged_at(pr) - opened).total_seconds()
    return max(seconds / stats.SECONDS_PER_HOUR, 0.0)


def stat_line(summary: dict[str, float]) -> str:
    """Render a median/fastest/slowest summary, or a not-enough-data notice."""
    if summary["slowest"] <= 0:
        return "not enough merges in the window yet"
    return (
        f"median **{fmt_hours(summary['median'])}** · "
        f"fastest {fmt_hours(summary['fastest'])} · "
        f"slowest {fmt_hours(summary['slowest'])}"
    )


def this_pr_tick_line(latest_tick_hours: float | None) -> str:
    """The just-merged PR's tick: the gap since the previous merge."""
    if latest_tick_hours is None:
        return "first tracked merge"
    return f"**{fmt_hours(latest_tick_hours)}** since the previous merge"


def this_pr_iter_line(latest_iterations: int | None) -> str:
    """Review rounds the just-merged PR took before its first LGTM."""
    if latest_iterations is None:
        return "merged without an LGTM verdict"
    if latest_iterations == 0:
        return "**0** rounds · clean first try"
    plural = "round" if latest_iterations == 1 else "rounds"
    return f"**{latest_iterations}** {plural} to LGTM"


def _churn(totals: dict[str, int]) -> str:
    """Render additions and deletions as ``+a / -d``."""
    return f"+{totals['additions']:,} / -{totals['deletions']:,}"


def loc_line(
    loc_24h: dict[str, int], loc_7d: dict[str, int], repo_net: int | None
) -> str:
    """Lines changed over 24 hours and 7 days, plus the whole repo's net."""
    full_repo = f"{repo_net:,} net" if repo_net is not None else "—"
    return f"{_churn(loc_24h)} (24h) · {_churn(loc_7d)} (7d) · {full_repo} (full repo)"


def footer_text(detailed: int, merged: int) -> str:
    """The embed footer, noting when per-PR figures cover only the newest merges."""
    if detailed >= merged:
        return FOOTER
    return (
        f"{FOOTER} · LoC and review iterations cover the newest "
        f"{detailed} of {merged} merges"
    )


def iter_summary_line(iters: dict[str, float]) -> str:
    """Render the 7-day review-round summary."""
    if not iters["sample"]:
        return "no LGTM verdicts in the last 7d"
    clean_pct = round(iters["clean_merge_rate"] * 100)
    return (
        f"**{iters['mean']:.1f}** avg rounds to LGTM · "
        f"**{clean_pct}%** first-try clean · "
        f"worst **{int(iters['max'])}** (n={int(iters['sample'])})"
    )


# --------------------------------------------------------------------------- #
# Recap assembly
# --------------------------------------------------------------------------- #


def _field(name: str, value: str, *, inline: bool = False) -> dict[str, Any]:
    """One Discord embed field."""
    return {"name": name, "value": value, "inline": inline}


def _this_pr_fields(facts: dict[str, Any]) -> list[dict[str, Any]]:
    """Fields describing the just-merged PR."""
    latest = facts["latest"]
    churn = facts["latest_churn"]
    footprint = (
        f"+{churn['additions']} / -{churn['deletions']} across {churn['files']} file(s)"
    )
    link = f"[#{latest['number']} — {latest['title']}]({latest['url']})"
    return [
        _field(BLANK, BLANK),
        _field(THIS_PR_HEADER, BLANK),
        _field("Unlock", f"*{facts['headline']}*"),
        _field("Link", link),
        _field("Footprint", footprint, inline=True),
        _field(
            "Review iterations",
            this_pr_iter_line(facts["latest_iterations"]),
            inline=True,
        ),
        _field(
            "Time for review",
            f"**{fmt_hours(facts['latest_ttm_hours'])}** open → merge",
            inline=True,
        ),
        _field(
            "Tick length", this_pr_tick_line(facts["latest_tick_hours"]), inline=True
        ),
    ]


def _loop_fields(facts: dict[str, Any]) -> list[dict[str, Any]]:
    """Fields describing the rolling and all-time loop figures."""
    rate = facts["rate"]
    busy = facts["busy"]
    estimate = facts["estimate"]
    merged = (
        f"{int(rate['last_24h'])} in 24h · {int(rate['last_7_days'])} in 7d · "
        f"**{facts['total_merged']}** all-time"
    )
    merge_rate = f"**{rate['per_hour']:.2f}**/hr (24h) · {rate['per_day']:.1f}/day (7d)"
    backlog = f"**{estimate['open_items']}** open · ETA {fmt_eta(estimate)}"
    return [
        _field(BLANK, BLANK),
        _field(LOOP_HEADER, BLANK),
        _field(
            "Busiest day (7d)",
            f"{busy[1]} merges on {busy[0]}" if busy else "—",
            inline=True,
        ),
        _field("PRs merged", merged, inline=True),
        _field("LoC", loc_line(facts["loc_24h"], facts["loc_7d"], facts["repo_net"])),
        _field("Merge rate", merge_rate, inline=True),
        _field("Review iterations (7d)", iter_summary_line(facts["iters"])),
        _field("Time for review (7d)", stat_line(facts["ttm"])),
        _field("Tick length (7d)", stat_line(facts["tick"])),
        _field("Backlog remaining", backlog, inline=True),
    ]


def render_embed(
    repo: str, facts: dict[str, Any], *, now: dt.datetime
) -> dict[str, Any]:
    """Turn computed facts into a Discord message payload with one embed.

    ``allowed_mentions`` with an empty ``parse`` list tells Discord to resolve
    no mentions at all, so a PR title carrying ``@everyone``, ``@here``, or a
    role or user mention can never ping the channel.
    """
    embed = {
        "title": f"Ralph Recap — {repo}",
        "url": f"https://github.com/{repo}/pulls?q=is%3Apr+is%3Amerged",
        "description": (
            "Another tick landed. Here's where the loop stands as of "
            f"<t:{int(now.timestamp())}:R>."
        ),
        "color": EMBED_COLOR,
        "fields": _this_pr_fields(facts) + _loop_fields(facts),
        "footer": {"text": footer_text(*facts["detail"])},
        "timestamp": now.isoformat(),
    }
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}


def _latest_summary(repo: str, pr: dict[str, Any]) -> dict[str, Any]:
    """The just-merged PR's public metadata: number, title, and link only."""
    number = int(pr["number"])
    return {
        "number": number,
        "title": str(pr.get("title", "")),
        "url": str(pr.get("html_url") or f"https://github.com/{repo}/pull/{number}"),
    }


def _review_rounds(
    repo: str, window: list[dict[str, Any]], *, token: str
) -> tuple[list[int], int | None, list[tuple[int, int, int]]]:
    """Per-PR review rounds and churn for ``window``; index 0 is the latest PR.

    This is the one place that makes API calls per PR (two each, typically), so
    callers pass only the PRs they can afford to detail.
    """
    iterations: list[int] = []
    churn: list[tuple[int, int, int]] = []
    latest_iterations: int | None = None
    for index, pr in enumerate(window):
        number = int(pr["number"])
        rounds = stats.iterations_before_lgtm(
            fetch_pr_verdicts(repo, number, token=token)
        )
        if rounds is not None:
            iterations.append(rounds)
        if index == 0:
            latest_iterations = rounds
        churn.append(pr_churn(repo, number, token=token))
    return iterations, latest_iterations, churn


def build_recap(
    repo: str,
    *,
    token: str,
    max_prs: int,
    now: dt.datetime,
    max_detail_prs: int = DEFAULT_MAX_DETAIL_PRS,
) -> dict[str, Any] | None:
    """Gather the merge history and assemble the Discord payload.

    Per-PR detail (review verdicts and diff counts) is fetched only for the
    newest ``max_detail_prs`` merges, and always for the just-merged one, so
    the API calls a run makes stay bounded however busy the window is. Counts,
    rates, and durations come from the window listing and still cover all of
    it. Returns None when nothing merged in the window.
    """
    since = (now - dt.timedelta(days=RECENT_WINDOW_DAYS)).date()
    window = fetch_recent_merged_prs(repo, token=token, since=since, max_prs=max_prs)
    if not window:
        return None
    merged_at = [pr_merged_at(pr) for pr in window]
    detailed = window[: max(1, max_detail_prs)]
    iterations, latest_iterations, churn = _review_rounds(repo, detailed, token=token)
    rate = stats.merge_rate(merged_at, now=now)
    day_ago = now - dt.timedelta(hours=stats.HOURS_PER_DAY)
    latest = _latest_summary(repo, window[0])
    tick_hours = stats.merge_intervals_hours(merged_at[:2])
    facts: dict[str, Any] = {
        "latest": latest,
        "headline": headline_from_title(latest["title"]),
        "total_merged": count_merged_total(repo, token=token),
        "rate": rate,
        "ttm": stats.time_to_merge_stats([open_to_merge_hours(pr) for pr in window]),
        "tick": stats.time_to_merge_stats(stats.merge_intervals_hours(merged_at)),
        "iters": stats.iteration_stats(iterations),
        "estimate": stats.estimate_remaining(
            count_open_backlog(repo, token=token), rate["per_day"], now=now
        ),
        "latest_churn": stats.churn_totals(churn[:1]),
        "loc_24h": stats.churn_totals(
            [
                c
                for c, ts in zip(churn, merged_at[: len(churn)], strict=True)
                if ts >= day_ago
            ]
        ),
        "loc_7d": stats.churn_totals(churn),
        "repo_net": fetch_repo_net_lines(repo, token=token),
        "busy": stats.busiest_day(merged_at),
        "latest_iterations": latest_iterations,
        "latest_ttm_hours": open_to_merge_hours(window[0]),
        "latest_tick_hours": tick_hours[0] if tick_hours else None,
        "detail": (len(detailed), len(window)),
    }
    return render_embed(repo, facts, now=now)


# --------------------------------------------------------------------------- #
# Delivery and entry point
# --------------------------------------------------------------------------- #


def post_to_discord(channel_id: str, token: str, payload: dict[str, Any]) -> None:
    """Post the payload to a Discord channel as a bot."""
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (ralph-recap, 1.0)",
    }
    _request_json(
        f"{DISCORD_API}/channels/{channel_id}/messages",
        headers=headers,
        method="POST",
        body=json.dumps(payload).encode("utf-8"),
    )


def _gather(
    repo: str, gh_token: str, max_prs: int, max_detail_prs: int
) -> dict[str, Any] | None:
    """Build the payload, mapping network failures to RecapError."""
    now = dt.datetime.now(dt.UTC)
    try:
        return build_recap(
            repo,
            token=gh_token,
            max_prs=max_prs,
            now=now,
            max_detail_prs=max_detail_prs,
        )
    except urllib.error.URLError as exc:  # HTTPError is a subclass
        raise ServiceError("GitHub", exc) from exc


def _deliver(channel_id: str, discord_token: str, payload: dict[str, Any]) -> None:
    """Post to Discord, mapping failures to RecapError."""
    try:
        post_to_discord(channel_id, discord_token, payload)
    except urllib.error.URLError as exc:  # HTTPError is a subclass
        raise ServiceError("Discord", exc) from exc


def _discord_settings(args: argparse.Namespace) -> tuple[str, str] | None:
    """Return (channel id, bot token), or None when either is missing."""
    channel_id = str(args.channel_id or "")
    discord_token = os.environ.get("DISCORD_BOT_TOKEN", "")
    if channel_id and discord_token:
        return channel_id, discord_token
    return None


def _run(args: argparse.Namespace) -> int:
    """Run one recap from parsed arguments; raises RecapError on failure."""
    settings = _discord_settings(args)
    if settings is None and not args.dry_run:
        if args.skip_if_unconfigured:
            print(
                "::notice::Ralph Recap skipped: DISCORD_BOT_TOKEN and "
                "RALPH_CHANNEL_ID are not both set."
            )
            return 0
        raise MissingSettingError("discord")
    if not args.repo:
        raise MissingSettingError("repo")
    gh_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not gh_token:
        raise MissingSettingError("github-token")
    payload = _gather(
        str(args.repo), gh_token, int(args.max_prs), int(args.max_detail_prs)
    )
    if payload is None:
        print("No merged PRs in the window; nothing to recap.")
        return 0
    if settings is None or args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0
    _deliver(settings[0], settings[1], payload)
    print("Posted Ralph Recap.")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and run the recap; returns the process exit code."""
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--channel-id", default=os.environ.get("RALPH_CHANNEL_ID"))
    parser.add_argument("--max-prs", type=int, default=DEFAULT_MAX_PRS)
    parser.add_argument("--max-detail-prs", type=int, default=DEFAULT_MAX_DETAIL_PRS)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-if-unconfigured", action="store_true")
    args = parser.parse_args(argv)
    try:
        return _run(args)
    except RecapError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
