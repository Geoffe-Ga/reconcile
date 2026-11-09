# ADR-0074: MVP Scope Revised: Each Feature at the Founder's Chosen Depth

- **Status:** Accepted; amended by [ADR-0075](0075-safeguards-for-the-revised-mvp.md) (safeguards for coalition seats, push, stewards and recovery)
- **Date:** 2026-11-08
- **Decided via:** the founder's scope slider sheet (2026-11-08). The founder read the 18-issue MVP and said: "You cut too much. Don't remove critical functionality identified in the vision and ship a shell… We are trying to make the vision real, not constrain or inflate it." Each slider started where the vision docs in [`docs/plan/`](../plan/) point, and the founder set the final depth for each feature.
- **Amends:** [ADR-0073](0073-mvp-scope.md). It lifts some of its deferrals and adds Phase 2 coalitions.

## Context

ADR-0073 cut Phase 1 to one group, one Document and one level, and left coalitions out entirely. The founder found that cut too thin to test the vision: Reconcile is about groups reconciling, and the MVP couldn't do it. The scope sheet set each feature on a scale from 0 (left out) through 1 (skeletal) to 5 (bloated, the full spec).

## Decision

The MVP builds each feature to the level below. ADR-0073's architecture stands unchanged:
- signed UTF-8 JSON events with SHA-256 ids, applied in relay order, with relay time for votes;
- independent random keys per group;
- one TypeScript engine;
- private drafts instead of shared CRDT drafts;
- polling;
- one VM.

| Feature | Level | The MVP includes |
|---|---|---|
| Onboarding & joining | 4 | Invite links; the full founding Document readable before joining ("reconcile user with group"); a first-run guide; vouches (2) and a 14-day wait before voting, with a bootstrap until a group has 3 voting members (ADR-0014, 0049) |
| Sign-in, devices & recovery | 4 | The backup file; passkey unlock (ADR-0008, 0030); adding a second device by scanning a code (ADR-0044, no device list or revocation); an encrypted relay backup; recovery contacts (3 of 5 by default) with a fixed 72-hour wait (ADR-0043) |
| Personal page | 2 | A personal mission statement on your device, and a read-only share link |
| Groups & involvement levels | 4 | Many groups; Member, Collaborator and Co-Creator levels, self-chosen and checked only through `can()` (ADR-0003, 0021); stewards with a 7-day suspension; removal by vote at the entrenched bar (ADR-0016, 0049) |
| Documents & Atoms | 5 | Several Documents per group, chosen at founding and added by Proposal; section history; add, remove and reorder sections, and heading-only sections; entrenched and eternal sections (ADR-0015); rule classes at genesis; dissolution with read-only archives (ADR-0051) |
| Proposals | 2 | Unchanged from ADR-0073: a private draft with Preview, word diffs, and up to 3 versions on one ballot |
| Discussion bridge | 4 | The linked chat; ready-made messages for each moment; a Discord bot that posts content-free nudges (ADR-0039, step 1); a Discord thread per Proposal with a join button |
| Voting | 3 | ADR-0073's rules, plus a window the proposer sets within the rule's bounds, and priority votes that change no Document |
| Notifications & followers | 3 | Opt-in, content-free Web Push (ADR-0012), including "closing soon"; Members as followers; Dispatches sent by a Co-Creator or carried by a passed Proposal |
| Coalitions | 4 | Reconcile two or more groups by vote in each; a coalition mission statement decided group by group (ADR-0036); front doors (ADR-0038); coalition followers; an encrypted coalition room (ADR-0011); nested coalitions; holonic promotion up to the top coalition (ADR-0037, 0071) |
| Privacy & safety | 3 | ADR-0073's floor, plus a new group key when anyone leaves or is removed; per-member encryption keys; mailboxes that rotate weekly (ADR-0019); ballots and notes that expire 30 days after a decision, leaving a signed result (ADR-0017, 0065) |

**Rules this needs, stated rather than asked:**
- **Windows.** Ordinary votes run 3–14 days (default 7) and entrenched votes 14–28 days (default 14). The entrenched bar is an average ≥ 3.0 with under 5% zeros (ADR-0015).
- **Rules are fixed at genesis**, with today's Fellowship defaults (ADR-0067) and no templates. There are two exceptions:
  - The opt-ins ADR-0040 governs (the chat bot and the front door) change by a rules Proposal: widening at the entrenched bar, narrowing at the ordinary bar.
  - Dissolution passes at the entrenched bar.
  Tuning any other rule by vote stays deferred.
- **Priority votes** take 2–7 options, each scored 0–4. The options that clear the consent floor and quorum are ranked by average, and the top one shows as the group's current focus.
- **The client gains one network destination.** It may call a Discord webhook, and only when the group has turned the bot on by Proposal. The webhook URL lives only in the encrypted group state. Signal and WhatsApp have no bot API for this, so their groups use the ready-made messages.
- **Recovery uses a random backup key** in place of ADR-0043's root key, because keys are random per group. Contacts hold Shamir shares of it.
- **Coalitions form by private, group-to-group invitation.** There is no public index. Reconcile-the-group, the covenant (ADR-0013) and Reconcile-wide broadcast stay deferred, so nothing in the MVP waits on the eternal core's wording (ADR-0035). Coalitions nest up to 3 levels.

### Lifted from ADR-0073

These ADR-0073 rows no longer apply to the parts listed above:
- one level;
- vouches and the 14-day wait;
- passkeys, social recovery, the relay backup and QR device linking;
- Atom and rule classes and dissolution;
- stewards, suspension, removal and key rotation;
- ballot and note expiry;
- Web Push;
- rotating mailboxes;
- the personal page.

Three of ADR-0073's accepted pilot risks are lifted:
- no key rotation;
- ballots that don't expire;
- no recovery contacts.

The relay is still trusted for order and time.

### Clarified while writing the issues

These follow from the levels above:
- **Passkeys without PRF.** Keys stay as ADR-0073 left them, and the app suggests recovery contacts rather than requiring them. ADR-0030's non-extractable key and mandatory recovery stay deferred, along with ADR-0052's recovery before voting.
- **Removal and suspension text.** The text of removal Proposals and suspension reasons stays in the signed log. Expiring it (ADR-0072 §5) stays deferred. A removal response is a separate event, so it expires with ballots.
- **Promotion ceilings.** A promotion ceiling is fixed once voting opens. Lowering it later (ADR-0037) stays deferred.
- **Mailboxes after dissolution.** The relay's 30-day retention deletes a dissolved group's mailboxes (ADR-0051), since nothing writes to them after the dissolve.

**Accepted pilot risks added:**
- **Coalition keys don't rotate.** Someone who leaves or is removed from a member group can still read that coalition and its room. They can contest that group's results, which then count as a fail, but they can't make a motion pass.
- **Push shows the relay some metadata.** It learns which mailboxes have opted-in phones. The "closing soon" nudge times reveal Proposal deadlines.

ADR-0058's outside review covers these too.

### Still deferred

Everything else in ADR-0073's table stays deferred:
- the roster hidden from Members;
- invite caps, revocation and QR invites;
- the older-device notice;
- app lock, the padded vault, panic wipe and duress;
- derived identities and link-reveal;
- genesis templates and rules changes beyond the opt-ins above;
- readmission and part-ways;
- re-proposal cooldowns and caps;
- stand-aside and per-version notes;
- the daily digest and scheduled Dispatches;
- the Quiet and Rising tabs;
- shared CRDT drafts, CodeMirror and line diffs;
- the binary encoding;
- the Python reference implementation;
- unique names;
- per-member mailboxes and delivery jitter;
- staging and production, and WebSockets.

## Consequences

- The backlog grows from 18 to 57 issues. The 18 filed issues stand. New epics build on them: membership and roles, Documents, rules, devices and recovery, privacy hardening, reaching people, and coalitions.
- The four lenses' warnings about capture and burden still apply. The pilot (ADR-0056) tells us which of these features groups use.
- ADR-0058's outside security review is still due before groups outside the founder's circle use the app, now covering the restored features too.
