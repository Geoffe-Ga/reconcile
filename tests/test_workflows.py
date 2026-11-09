"""Guards over the GitHub Actions workflows in .github/workflows/.

Actions masks secrets in job logs but not variables, and anyone who can read
the repository can read its variables. So a token must only ever come from
``secrets``. These tests hold that for ``DISCORD_BOT_TOKEN`` (issue #137).
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


def test_workflow_files_exist() -> None:
    """The parametrized checks below have files to run over."""
    assert WORKFLOWS / "ralph-recap.yml" in WORKFLOW_FILES


@pytest.mark.parametrize("path", WORKFLOW_FILES, ids=lambda path: path.name)
def test_discord_token_comes_only_from_secrets(path: Path) -> None:
    """No workflow reads DISCORD_BOT_TOKEN from vars or sets it from anything else."""
    assert _token_problems(path.read_text(encoding="utf-8")) == []


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
