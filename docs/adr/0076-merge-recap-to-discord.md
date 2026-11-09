# ADR-0076: Merge Recaps Send Only Metadata to Discord

- **Status:** Accepted. Tooling, not product architecture
- **Date:** 2026-11-09
- **Decided via:** PR #47, which ported the Ralph Recap from the adepthood repository and removed its AI-written headline. The review of #47 suggested recording the data flow as an ADR ([#54](https://github.com/Geoffe-Ga/reconcile/issues/54)). PR #136 added the mention block. The operating details live in [`scripts/ralph/RECAP.md`](../../scripts/ralph/RECAP.md).
- **Scope:** `scripts/ralph/` and `.github/workflows/ralph-recap.yml`. Nothing in the app, the relay or the protocol changes.

## Context

When a PR merges, a GitHub Actions workflow posts a recap of the merge loop to a Discord channel. That sends repository data to a third party. The repository is private, and the threat model treats project content as sensitive ([`CLAUDE.md`](../../CLAUDE.md), "Defend Against Weaponization").

The recap serves the people building Reconcile. It reads only GitHub's history, never the relay or anyone's device, so no data from Reconcile's users can reach it.

## Decision

### What goes to Discord

Merge metadata only:
- the merged PR's number, link and title, with its `feat(...)`-style prefix removed;
- the repository's name;
- counts: lines added and removed, files changed, review rounds, PRs merged, and open issues left;
- durations: time from open to merge, and the gaps between merges;
- figures worked out from these, such as the merge rate and a backlog ETA.

**PR titles do reach Discord.** Keep each title free of anything you wouldn't post in that channel.

### What never goes

- PR bodies, diffs, file names and file contents.
- The text of review comments. The recap reads them only to find the `## Verdict:` line, then discards them.
- Anything sent through an AI service. adepthood's recap had an AI service write its headline from the PR body, so the port removed it.

Sending anything beyond merge metadata needs a new ADR that supersedes this one.

### Trust model

- The workflow runs on `pull_request: closed`. It runs the merged PR's own copy of the recap, with `DISCORD_BOT_TOKEN` in its environment. So a PR that changes the recap runs its change with the real token as soon as it merges.
- That is the same trust as any CI script a collaborator can change, so it opens no new hole. The gate is a merge to `main`. Branch protection on `main` ([ADR-0060](0060-how-phase-1-is-built.md)) waits on GitHub Pro ([decision roadmap](../spec/decision-roadmap.md)), so until it's on, anyone with write access can merge.
- Only the posting step sees the token, and it installs no packages. RECAP.md's "Secrets and trust" lists every file that runs with the token. A change that adds an import or a package updates that list.
- GitHub's built-in token reads the merge history with read-only permissions.

### Mitigations

- **Mentions never ping.** The payload sets `allowed_mentions` to parse nothing, so `@everyone`, `@here`, or a role or user mention in a title notifies no one.
- **The channel is private.** Only the people building Reconcile can read it.
- **The bot exists only for the recap.** It's in one server, with View Channel and Send Messages on one channel. A Discord bot token controls the whole bot account, so a narrow bot limits what a leaked token can do.
- **The token is a secret, never a variable.** Job logs don't mask variables, and anyone who can read the repository can read them. A leaked token is reset in the Discord Developer Portal.
- **Nothing posts until it's configured.** Without both the token and the channel ID, the workflow prints a notice and exits.

## Consequences

- Discord learns the project's PR titles and how often it merges. We accept that because the channel holds nothing about Reconcile's users.
- A change to the files RECAP.md lists gets the care we give any code that holds a secret.

## Open Questions

None.
