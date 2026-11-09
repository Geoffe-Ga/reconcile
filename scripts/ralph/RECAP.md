# Ralph Recap

When a PR merges, this posts one Discord embed in two blocks:

- **This PR:** a short headline (the PR title without its `feat(...)`-style prefix), the link, the footprint (lines added and removed, files changed), review rounds before LGTM, time from open to merge, and the gap since the previous merge.
- **The loop:** the busiest day, PRs merged (24 hours, 7 days, all time), lines changed, merge rate, review rounds, review time, tick length, and backlog remaining with an ETA.

Ported from the adepthood repository and trimmed for Reconcile.

## Privacy

This repo is private, and its threat model treats project content as sensitive (`CLAUDE.md`, "Defend Against Weaponization"). The recap posts **merge metadata only**: PR numbers, titles, links, counts, durations, and review-round numbers.

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
.github/workflows/ralph-recap.yml                       # fires on every merged PR
```

## Setup

Nothing posts until both settings exist. Until then the workflow prints a notice and exits 0.

1. Create a Discord bot, add it to your server, and give it **View Channel** and **Send Messages** on the target channel.
2. Copy the channel ID (Developer Mode → right-click the channel → Copy Channel ID).
3. Add the settings to the repo. The workflow reads `secrets` first, then a same-named `vars` entry:

```bash
gh secret set DISCORD_BOT_TOKEN
gh secret set RALPH_CHANNEL_ID   # or: gh variable set RALPH_CHANNEL_ID --body "1234..."
```

The built-in `GITHUB_TOKEN` reads the merge history (`contents`, `pull-requests`, and `issues`, all read-only).

## Dry run

`--dry-run` prints the embed as JSON instead of posting, and needs no Discord settings:

```bash
GITHUB_TOKEN="$(gh auth token)" python -m scripts.ralph.recap --repo OWNER/REPO --dry-run
```

## Metrics

All math lives in `stats.py`. The all-time merged count comes from the search API. Everything else covers the trailing **7 days**, capped at `--max-prs` (default 200).

- **Review iterations:** the non-LGTM verdicts before a PR's first LGTM. PRs that never reached LGTM (for example COMMENTS merges) are left out of the average.
- **Time for review:** `merged_at − created_at`, clamped at zero.
- **Tick length:** the gap between consecutive merges.
- **LoC:** additions and deletions summed from each PR's counts, plus the whole repo's net from GitHub's code-frequency stats. That figure warms up asynchronously and shows "—" when GitHub hasn't computed it yet.
- **Backlog remaining:** open issues, excluding PRs and issues labeled `epic`, `blocked`, `wontfix`, `duplicate`, `invalid`, or `question`. Override with `RALPH_EXCLUDE_LABELS` (space-separated). The ETA is the backlog divided by the 7-day merges per day.

## Troubleshooting

- **401:** a wrong or revoked token. Use the bot token without a `Bot ` prefix; the script adds it.
- **403:** the bot isn't in the server, or lacks View Channel or Send Messages.
- **404:** a wrong `RALPH_CHANNEL_ID`. It's all digits, not the channel name.
- **"Ralph Recap skipped"** in the job log: one or both settings are missing.
