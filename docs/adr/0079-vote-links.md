# ADR-0079: Vote Links Open One Proposal, and Only on Its Group's Devices

- **Status:** Accepted
- **Date:** 2026-11-17
- **Decided via:** the founder's request (2026-11-16): "make the links to proposals open the exact proposal that they are notifying on … Both in the discord integration and in share links … something that they can put in the search bar to go straight to the vote (whatever proposal it might be, whether for doc changes, a coalition, opening a front door, etc)", and their go-ahead to record the design below. §4's default is the recommendation they were given; see Open questions.
- **Amends:** spec §9 ("Shares carry no content"), §8 item 20 (Link bar) and §8.1 (first run); [ADR-0039](0039-integrations-per-group-opt-in.md) step 1, whose notice now carries a vote link
- **Built by:** #472

## Context

Every Proposal has its own page in the app, `#/g/{groupId}/p/{proposalId}`. Every kind of vote has one: a change to a Document, a front door's opt-in, a reconcile Proposal, and a coalition motion, which opens as a Proposal in each member group (`crossing.ts`). But nothing that leaves the app links to that page. Tell your group (#113) and the Discord bot (#119, #123) send a fixed line and the app's bare address, because spec §9 says a share never carries a link fragment. Someone who gets the nudge has to open the app and find the vote on their own.

The obvious fix is to put the page's own address in the share. That would tell the chat platform two things it doesn't know now:

1. **Which groups share a coalition.** A coalition motion keeps its id in every group beneath it. If two groups' chats both carry a link to it, anyone who reads both can see that the two groups are in one coalition. Discord holds every server's messages in plaintext. The threat model counts the coalition graph as high-risk data.
2. **A label for the group.** A group's id is the id of its genesis event. It's the same in every link, in every chat a link lands in, for the group's whole life.

On an iPhone, a tapped link opens in Safari, which keeps its storage apart from the installed app's. So copy, open the app, and paste into the link bar (#444) is how most links arrive there. Whatever form a vote link takes, the link bar has to read it.

## Decision

### 1. A vote link carries a token, not ids

A vote link is `https://<app>/#vote/{token}`. Like `#join/` and `#door/`, it's a link's own form, with no slash after `#`.

The token is the first 16 bytes of HKDF-SHA-256 (ikm = the group's secret, empty salt, info = UTF-8 `reconcile/v1/vote-link` ‖ 0x00 ‖ the Proposal id's UTF-8), in unpadded base64url: 22 characters. `src/crypto` derives it, and a golden vector made outside @noble pins it, as `vectors/derive.json` pins the mailbox ids.

- **Only the group can make or read a token.** A device that holds the group's secret computes the token for each of its Proposals and finds the match. To anyone else, a token is 22 random characters.
- **One vote has a different link in each group.** Each group's secret goes into its tokens, so a coalition motion's token in one group has nothing in common with its token in another.
- **The link labels no group.** Two links to two votes in one group look unrelated.
- **One vote always has the same link** while the group's key stays the same. Every device that might post the bot's notice for a moment writes the same words. A chat can tell that two shares point to one vote, which its thread already says.
- **No server sees a token.** Browsers never send the part after `#`, so neither the relay nor the app's host sees one. A chat app that previews the link fetches the bare page.

### 2. A key change retires older links

The token uses the secret of the group's current epoch (#98). A device keeps only that secret, so once it takes up a new key, a link made before the change no longer opens there; it reads as a vote that isn't on this device. Keys change only when someone leaves or is removed. A person who left keeps the old secret, so they can still open links made before they left, which name votes they saw. They can't open any link made after.

### 3. Opening a vote link

- **From the address bar**, on a device past first run, `#vote/{token}` is matched across every group the device holds. It then replaces itself with the Proposal's page, so Back skips it. An open vote shows its ballot, and a decided one its result.
- **From the link bar** (#444), `linkKind` reads a vote link as a kind of its own, "A vote", and Open goes the same way. A token holds no secret, so like a front door's address it may stay in the address bar.
- **When no Proposal matches**, the device waits for the sync pass under way, since the vote may not have reached it yet, then checks once more. If there's still no match, it says the vote isn't on this device and opens only on a device that's in the vote's group. It gives no hint of which group, or whether the token was ever real.
- **A device that holds no group can't open a vote link.** That includes a fresh browser, and Safari beside an installed app on an iPhone. On an iPhone or iPad, the install guide holds the link to copy, as it holds an invite's, and says to open Reconcile from the Home Screen and paste the link into the bar at the top. Elsewhere, first run goes as it does for a plain visit, and the not-on-this-device line shows once first run is through.

### 4. Where vote links go

- **Tell your group** (#113): the vote link replaces the app's address as the message's last line. That holds for every kind of Proposal, steward and removal Proposals included, since a token names no one. "Include the title" stays as it is.
- **The Discord bot** (#119, #123): the vote link replaces the address line in each notice, in the channel and in the Proposal's thread. The thread's name stays "Proposal {n} in Reconcile".
- **Copy link to this vote**, on a Proposal's page and on its result, with one line beside it: "Only people in this group can open this link."
- **The link goes in by default.** The Proposal's title still goes in only when someone ticks Include the title.

### 5. What doesn't change

- The bot still posts nothing about a coalition motion opened from outside (#100), since such a motion has no number and no chat bot claims. Its vote link reaches a chat through Tell your group or Copy link.
- No relay request, stored record or backup gains a token. A device computes a token when it shares or opens a link, and keeps none.
- Push stays content-free ([ADR-0012](0012-content-free-push.md)): a notification never carries a link.

**Not chosen:**
- *The page's own address, `#/g/{groupId}/p/{proposalId}`.* It shows which groups share a coalition, and labels the group (Context).
- *A random token for each share.* The device would have to keep every token it handed out, which is a list of its shares, and two devices posting the bot's notice for one moment would post different links.
- *A token keyed by the group's id instead of its secret.* The id isn't secret: it's in every in-app address and in browser history. Anyone holding it and a motion's id could match the group's links, and a member of a partner group and a coalition's follower both hold motion ids.
- *A tick, "Include a link", unticked each time.* It keeps §9's rule unchanged, but it costs the most useful part of the nudge. A token tells a chat platform nothing a notice doesn't already tell it: that the group uses Reconcile.

## Consequences

- Spec §9's "Shares carry no content" adds vote links to the links whose fragment is the point. To whoever runs the chat, a vote link says only that a vote exists. Its other rules stand.
- Spec §8 item 20 gains a sixth link kind, "A vote". §8.1 lets the install guide hold a vote link.
- ADR-0039's step 1 row stands: the platform still learns that the group uses Reconcile, and nothing more.
- The bot's notice is no longer a function of the moment and deadline alone: it needs the Proposal's id and the group's secret. The bot runs on a member's device, which holds both.
- **A device that's taken can open a group's vote links in a chat's history**, tying those chat accounts to the group's records. It could already do that through the group's chat link or the bot's webhook, both in the group's log. Vote links add this only for Tell your group shares in chats the group never linked.
- Tests: a golden vector for the token; fast-check properties that one Proposal id gives different tokens under different secrets, and that a device resolves each token it makes to its Proposal; and end-to-end request captures that find no token, group id or Proposal id in any request, plus a check that one coalition motion's links from two groups differ.

## Open questions

- **On by default, or a tick?** The founder asked for the link in Discord notices and in shares. This ADR puts it in every share by default. The other choice is a tick that starts unticked each time, as the title's does. The founder hasn't confirmed which.
- **Links across a key change.** If pilots find that links stop opening after a leave and that gets in the way, a device could keep the derived link key of each epoch it held. That keeps no secret, only a key that opens nothing but vote links.
