# Ralph Recap

When a PR merges, this posts one Discord embed in two blocks:

- **This PR:** a short headline (the PR title without its `feat(...)`-style prefix), the link, the footprint (lines added and removed, files changed), review rounds before LGTM, time from open to merge, and the gap since the previous merge.
- **The loop:** the busiest day, PRs merged (24 hours, 7 days, all time), lines changed, merge rate, review rounds, review time, tick length, and backlog remaining with an ETA.

Ported from the adepthood repository and trimmed for Reconcile.

## Privacy

This repo is private, and its threat model treats project content as sensitive (`CLAUDE.md`, "Defend Against Weaponization"). The recap posts **merge metadata only**: PR numbers, titles, links, counts, durations, and review-round numbers. [ADR-0076](../../docs/adr/0076-merge-recap-to-discord.md) records this decision and its trust model.

- It never reads or posts PR bodies, diffs, file names, or file contents.
- Review comments are read only to find the `## Verdict:` line, and their text is discarded.
- It calls no AI service. adepthood's Claude-written headline was removed because it sent PR bodies to a third party.
- **PR titles do reach Discord.** Keep titles free of anything you wouldn't post in that channel, and keep the channel private.
- Mentions never ping. The payload sets `allowed_mentions` to parse nothing, so `@everyone`, `@here`, or a role or user mention in a title notifies no one.

## Files

```
scripts/ralph/
├── recap.py   # I/O: read GitHub history, build the embed, post it
├── stats.py   # pure statistics
└── RECAP.md   # this file
tests/test_ralph_recap.py, tests/test_ralph_stats.py   # run by ./scripts/check-all.sh
tests/test_workflows.py                                 # the token comes only from secrets
.github/workflows/ralph-recap.yml                       # fires on every merged PR
```

## Setup

Nothing posts until both settings exist. Until then the workflow prints a notice and exits 0.

1. Create a Discord bot, add it to your server, and give it **View Channel** and **Send Messages** on the target channel.
2. Copy the channel ID (Developer Mode → right-click the channel → Copy Channel ID).
3. Add the settings to the repo. The bot token must be a secret: the workflow reads `DISCORD_BOT_TOKEN` from `secrets` only, so a variable of that name is ignored. Variables aren't masked in job logs, and anyone who can read the repo can read them. The channel ID isn't secret, so it can be either; a secret wins over a same-named variable.

```bash
gh secret set DISCORD_BOT_TOKEN
gh secret set RALPH_CHANNEL_ID   # or: gh variable set RALPH_CHANNEL_ID --body "1234..."
```

The built-in `GITHUB_TOKEN` reads the merge history (`contents`, `pull-requests`, and `issues`, all read-only).

`tests/test_workflows.py` fails if any workflow reads `DISCORD_BOT_TOKEN` from `vars` or sets it from anything but `secrets.DISCORD_BOT_TOKEN`.

## Secrets and trust

The workflow fires on `pull_request: closed` and runs the merged PR's own copy of the recap with `DISCORD_BOT_TOKEN` in its environment. A PR that edits that code runs its edit with the real token as soon as it merges. That's the same trust level as any CI script a collaborator can change, and it needs a merge to `main`, so it isn't a new hole. It does mean a change to the files below deserves the care you'd give any code that holds a secret. Branch protection on `main` ([ADR-0060](../../docs/adr/0060-how-phase-1-is-built.md)) waits on GitHub Pro, so until then the gate is write access to the repo.

Code that runs with `DISCORD_BOT_TOKEN` (keep this list current, per ADR-0060):

- `scripts/ralph/recap.py`, the entry point
- `scripts/ralph/stats.py`, which it imports
- `scripts/__init__.py` and `scripts/ralph/__init__.py`, which `python -m` runs first
- the Python standard library that `actions/setup-python` installs

Only the posting step sees the token; checkout and Python setup run before it, without the secret. The step installs no packages. If a change makes the recap import another module or install a package, add it to this list.

A Discord bot token controls the whole bot account, not one channel. Use a bot made for this recap, add it to this server only, and give it only the two channel permissions above. If the token leaks, reset it in the Discord Developer Portal and run `gh secret set DISCORD_BOT_TOKEN` again.

## Dry run

`--dry-run` prints the embed as JSON instead of posting, and needs no Discord settings:

```bash
GITHUB_TOKEN="$(gh auth token)" python -m scripts.ralph.recap --repo OWNER/REPO --dry-run
```

## Metrics

All math lives in `stats.py`. The all-time merged count comes from the search API. Everything else covers the trailing **7 days**, capped at `--max-prs` (default 200).

Review verdicts and diff counts take about two API requests per PR, so only the newest `--max-detail-prs` merges (default 50, and always the one that just merged) get them. That keeps a typical run near 110 requests, where a full 200-PR window would cost about 400, and inside the 1,000 per hour per repository that GitHub allows the Actions `GITHUB_TOKEN`, even when several PRs merge in an hour. When the window holds more PRs than that, LoC and review iterations cover only the newest ones, and the embed's footer says so. Merge counts, rates, and durations still cover the whole window.

- **Review iterations:** the non-LGTM verdicts before a PR's first LGTM. PRs that never reached LGTM (for example COMMENTS merges) are left out of the average. Verdicts are read from a PR's first 1,000 comments, oldest first.
- **Time for review:** `merged_at − created_at`, clamped at zero.
- **Tick length:** the gap between consecutive merges.
- **LoC:** additions and deletions summed from each PR's counts, plus the whole repo's net from GitHub's code-frequency stats. That figure warms up asynchronously and shows "—" when GitHub hasn't computed it yet.
- **Backlog remaining:** open issues, excluding PRs and issues labeled `epic`, `blocked`, `wontfix`, `duplicate`, `invalid`, or `question`. Override with `RALPH_EXCLUDE_LABELS` (space-separated). The ETA is the backlog divided by the 7-day merges per day.

## Troubleshooting

- **401:** a wrong or revoked token. Use the bot token without a `Bot ` prefix; the script adds it.
- **403:** the bot isn't in the server, or lacks View Channel or Send Messages.
- **404:** a wrong `RALPH_CHANNEL_ID`. It's all digits, not the channel name.
- **"Ralph Recap skipped"** in the job log: one or both settings are missing. A bot token saved as a variable counts as missing; save it with `gh secret set DISCORD_BOT_TOKEN`.
