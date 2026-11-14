"""Guards over the GitHub Actions workflows in .github/workflows/.

Actions masks secrets in job logs but not variables, and anyone who can read
the repository can read its variables. So a token must only ever come from
``secrets``. These tests hold that for ``DISCORD_BOT_TOKEN`` (issue #137).

Every job also names its own ``timeout-minutes``. Without one, a hung job runs
to GitHub's six-hour limit, and every minute of it is billed.

The docs graph builds nightly and on demand, never on a merge to ``main`` (the
founder's choice on 2026-11-14).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
import yaml

if TYPE_CHECKING:
    from collections.abc import Iterator

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
WORKFLOW_FILES = sorted(WORKFLOWS.glob("*.yml"))
TOKEN = "DISCORD_BOT_TOKEN"
SECRET_ONLY = "${{ secrets.DISCORD_BOT_TOKEN }}"
# vars.DISCORD_BOT_TOKEN or vars['DISCORD_BOT_TOKEN']; Actions contexts ignore case.
VARS_READ = re.compile(
    r"\bvars\s*(?:\.\s*|\[\s*['\"])DISCORD_BOT_TOKEN\b", re.IGNORECASE
)
# GitHub-hosted runners stop any job at 360 minutes, so a longer timeout means nothing.
MAX_TIMEOUT = 360
EXPRESSION = re.compile(r"^\$\{\{.+\}\}$", re.DOTALL)
GRAPH_DOCS = WORKFLOWS / "graph-docs.yml"
# GitHub delays, and under load drops, schedules at the top of the hour.
BUSY_MINUTES = (0, 30)


def _strings(node: Any) -> Iterator[str]:
    """Yield every string scalar (keys and values) in a parsed YAML tree."""
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for key, value in node.items():
            yield from _strings(key)
            yield from _strings(value)
    elif isinstance(node, list):
        for item in node:
            yield from _strings(item)


def _values_for(node: Any, key: str) -> Iterator[Any]:
    """Yield every value mapped to ``key`` anywhere in a parsed YAML tree."""
    if isinstance(node, dict):
        for name, value in node.items():
            if name == key:
                yield value
            yield from _values_for(value, key)
    elif isinstance(node, list):
        for item in node:
            yield from _values_for(item, key)


def _token_problems(text: str) -> list[str]:
    """List each place a workflow could take the token from anywhere but secrets."""
    tree = yaml.safe_load(text)
    problems = [s for s in _strings(tree) if VARS_READ.search(s)]
    problems += [repr(v) for v in _values_for(tree, TOKEN) if v != SECRET_ONLY]
    return problems


def _timeout_problems(text: str) -> list[str]:
    """Name each job that has no usable ``timeout-minutes``.

    A usable one is a whole number of minutes from 1 to 360, or an expression
    (graph-docs.yml gives a full rebuild longer than a routine one).
    """
    problems = []
    for name, job in yaml.safe_load(text)["jobs"].items():
        timeout = job.get("timeout-minutes")
        if isinstance(timeout, str) and EXPRESSION.match(timeout.strip()):
            continue
        usable = isinstance(timeout, int) and not isinstance(timeout, bool)
        if not usable or not 1 <= timeout <= MAX_TIMEOUT:
            problems.append(f"{name}: {timeout!r}")
    return problems


def _triggers(path: Path) -> dict[str, Any]:
    """A workflow's ``on:`` block. YAML 1.1 reads a bare ``on`` key as True."""
    workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
    triggers: dict[str, Any] = workflow["on"] if "on" in workflow else workflow[True]
    return triggers


def test_workflow_files_exist() -> None:
    """The parametrized checks below have files to run over."""
    assert WORKFLOWS / "ralph-recap.yml" in WORKFLOW_FILES


@pytest.mark.parametrize("path", WORKFLOW_FILES, ids=lambda path: path.name)
def test_discord_token_comes_only_from_secrets(path: Path) -> None:
    """No workflow reads DISCORD_BOT_TOKEN from vars or sets it from anything else."""
    assert _token_problems(path.read_text(encoding="utf-8")) == []


@pytest.mark.parametrize("path", WORKFLOW_FILES, ids=lambda path: path.name)
def test_every_job_sets_its_own_timeout(path: Path) -> None:
    """A hung job stops at its own timeout, not at GitHub's six-hour default."""
    assert _timeout_problems(path.read_text(encoding="utf-8")) == []


@pytest.mark.parametrize(
    ("job", "problem"),
    [
        ("runs-on: ubuntu-latest", "build: None"),
        ("timeout-minutes: 0", "build: 0"),
        ("timeout-minutes: 361", "build: 361"),
        ("timeout-minutes: '30'", "build: '30'"),
        ("timeout-minutes: true", "build: True"),
    ],
)
def test_timeout_guard_flags_a_missing_or_unusable_timeout(
    job: str, problem: str
) -> None:
    """No timeout, a zero, more than the runner allows, or a non-number is caught."""
    assert _timeout_problems(f"jobs:\n  build:\n    {job}\n") == [problem]


def test_docs_graph_builds_nightly_and_on_demand_never_on_a_push() -> None:
    """A merge to main starts no docs build; a dispatch can still force a full one."""
    triggers = _triggers(GRAPH_DOCS)
    assert sorted(triggers) == ["schedule", "workflow_dispatch"]
    assert "full_rebuild" in triggers["workflow_dispatch"]["inputs"]


def test_docs_graph_runs_once_a_day_off_the_busy_minutes() -> None:
    """One daily cron, at a set minute and hour other than :00 or :30."""
    schedule = _triggers(GRAPH_DOCS)["schedule"]
    assert len(schedule) == 1, schedule
    minute, hour, *days = schedule[0]["cron"].split()
    assert days == ["*", "*", "*"]
    assert hour.isdigit() and 0 <= int(hour) <= 23
    assert minute.isdigit() and int(minute) not in BUSY_MINUTES


@pytest.mark.parametrize(
    "timeout", ["1", "360", "${{ inputs.full_rebuild && 45 || 30 }}"]
)
def test_timeout_guard_accepts_minutes_and_expressions(timeout: str) -> None:
    """Whole minutes within the runner's limit pass, and so does an expression."""
    assert _timeout_problems(f"jobs:\n  build:\n    timeout-minutes: {timeout}\n") == []


def test_recap_step_receives_the_token_as_a_secret() -> None:
    """The recap step still gets the token, so the check above isn't vacuous."""
    workflow = yaml.safe_load((WORKFLOWS / "ralph-recap.yml").read_text("utf-8"))
    envs = [step.get("env", {}) for step in workflow["jobs"]["recap"]["steps"]]
    assert [env[TOKEN] for env in envs if TOKEN in env] == [SECRET_ONLY]


def test_guard_flags_the_vars_fallback() -> None:
    """The fallback #137 removed is caught twice: a vars read and a non-secret value."""
    text = (
        "env:\n"
        "  DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN"
        " || vars.DISCORD_BOT_TOKEN }}\n"
    )
    value = "${{ secrets.DISCORD_BOT_TOKEN || vars.DISCORD_BOT_TOKEN }}"
    assert _token_problems(text) == [value, repr(value)]


@pytest.mark.parametrize(
    "reference",
    ["vars.DISCORD_BOT_TOKEN", "vars.discord_bot_token", "vars['DISCORD_BOT_TOKEN']"],
)
def test_guard_flags_a_vars_read_anywhere(reference: str) -> None:
    """A vars read in a script is caught, in any case and either access syntax."""
    text = f'steps:\n  - run: echo "${{{{ {reference} }}}}"\n'
    assert _token_problems(text) == [f'echo "${{{{ {reference} }}}}"']


def test_guard_flags_the_token_set_from_another_source() -> None:
    """Setting the token from any other expression is caught."""
    assert _token_problems("env:\n  DISCORD_BOT_TOKEN: ${{ vars.BOT }}\n") == [
        repr("${{ vars.BOT }}")
    ]


def test_guard_accepts_a_secret_and_other_vars() -> None:
    """The token as a secret passes, and other names may still use vars."""
    text = (
        "env:\n"
        "  DISCORD_BOT_TOKEN: ${{ secrets.DISCORD_BOT_TOKEN }}\n"
        "  RALPH_CHANNEL_ID: ${{ secrets.RALPH_CHANNEL_ID"
        " || vars.RALPH_CHANNEL_ID }}\n"
        "  DISCORD_BOT_TOKEN_HINT: ${{ vars.DISCORD_BOT_TOKEN_HINT }}\n"
    )
    assert _token_problems(text) == []
