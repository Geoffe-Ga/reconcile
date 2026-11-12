/**
 * Golden vectors: the engine's contract (ADR-0073, docs/spec/phase-1-spec.md §3–§5).
 *
 * src/test/vectors.ts reads each file in vectors/ and builds its records; its
 * header documents the format. This file runs every tally and fold vector.
 */
import { describe, expect, it } from 'vitest';

import { concat, fromHex } from '../test/bytes';
import { type FoldedLog, folded, foldLogs, seatOf } from '../test/coalitions';
import {
  buildLogs,
  buildRecords,
  COALITION_VECTORS,
  FOLD_VECTORS,
  publicKeyNamed,
  resolve,
  SEEDS,
  TALLY_VECTORS,
  VECTOR_FILES,
} from '../test/vectors';
import { resultMismatches, resultsToReport } from './crossing';
import { fold } from './fold';
import { DEFAULT_RULES } from './rules';
import { rank, tally } from './tally';

/** What a member group owes and what it would flag, each for the seat it holds (#100). */
function crossings(logs: Record<string, FoldedLog>, log: string) {
  const { state } = folded(logs, log);
  const seat = seatOf(logs, log);
  const coalition = folded(logs, 'coalition').state;
  return {
    report: resultsToReport(state, coalition, seat),
    mismatches: resultMismatches(state, coalition, seat),
  };
}

describe('vector files', () => {
  it('are the keys, then tally, fold, coalition or atom-text files', () => {
    expect(Object.keys(VECTOR_FILES).sort()).toEqual([
      'atom-text.json',
      'bars-entrenched-edges.json',
      'bars-ordinary-pairs.json',
      'bars-removal-edges.json',
      'bootstrap-joins.json',
      'bootstrap-member-churn.json',
      'chat-posted-first.json',
      'chat-posted-ignored.json',
      'chat-thread-first.json',
      'chat-thread-ignored.json',
      'coalition-admit.json',
      'coalition-contest.json',
      'coalition-forgery.json',
      'coalition-formation.json',
      'coalition-group.json',
      'coalition-room-wrap.json',
      'coalition-thresholds.json',
      'dispatch-carried.json',
      'dispatch-limits.json',
      'dispatch-sent.json',
      'dissolve-bar.json',
      'dissolve-ignored.json',
      'dissolve-proposal.json',
      'dissolve-rotate.json',
      'dissolve-terminal.json',
      'dissolve-unfinished.json',
      'dissolve-window.json',
      'door-class.json',
      'door-invited.json',
      'fold.json',
      'home-two-open-proposals.json',
      'invite.json',
      'keys.json',
      'leave-ballots.json',
      'leave-eligibility.json',
      'leave-events.json',
      'leave-stewards.json',
      'levels-capabilities.json',
      'levels-eligible-count.json',
      'levels-step-down.json',
      'levels-step-up-after-open.json',
      'optin-class.json',
      'optin-ignored.json',
      'optin-narrow.json',
      'priority-admission.json',
      'priority-chat-thread.json',
      'priority-cleared.json',
      'priority-coalition.json',
      'priority-dispatch.json',
      'priority-dissolve.json',
      'priority-focus.json',
      'priority-options.json',
      'priority-rank.json',
      'priority-suspend.json',
      'proposal-number.json',
      'recovery-share-coalition.json',
      'recovery-share.json',
      'removal-bar.json',
      'removal-priority.json',
      'removal-proposal.json',
      'removal-remove.json',
      'removal-response.json',
      'removal-rotate.json',
      'removal-suspension.json',
      'removal-target-ineligible.json',
      'result-checks.json',
      'result-cleared.json',
      'result-mismatch.json',
      'result-no-votes.json',
      'room-fold.json',
      'room-ignored.json',
      'room-keys.json',
      'rotate-admission.json',
      'rotate-epochs.json',
      'rotate-exact-recipients.json',
      'rotate-ignored.json',
      'rotate-kx.json',
      'rules-class-forged.json',
      'rules-genesis-defaults.json',
      'rules-genesis-differs.json',
      'rules-genesis-missing.json',
      'sections-add.json',
      'sections-admission.json',
      'sections-anchor-removed.json',
      'sections-chat-thread.json',
      'sections-coalition.json',
      'sections-dispatch.json',
      'sections-dissolve.json',
      'sections-pass-order.json',
      'sections-remove.json',
      'sections-rotate.json',
      'signatures.json',
      'steward-recall.json',
      'steward-seats.json',
      'steward-step-down.json',
      'steward-terms.json',
      'steward-validity.json',
      'suspend-effects.json',
      'suspend-ignored.json',
      'suspend-lapse.json',
      'tally.json',
      'time.json',
      'versions-ballot.json',
      'versions-early-close.json',
      'versions-late-low-quorum.json',
      'versions-one-open.json',
      'versions-tie.json',
      'vouch-ignored.json',
      'vouch-levels.json',
      'vouch-second-after-wait.json',
      'vouch-wait-boundary.json',
      'window-bounds.json',
      'window-deadline.json',
    ]);
    expect(Object.values(VECTOR_FILES).map((file) => file.kind)).toEqual([
      'atom-text',
      'tally',
      'tally',
      'tally',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'coalition',
      'coalition',
      'coalition',
      'coalition',
      'coalition',
      'coalition',
      'coalition',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'keys',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'coalition',
      'fold',
      'fold',
      'fold',
      'fold',
      'tally',
      'fold',
      'fold',
      'coalition',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'room',
      'fold',
      'room-keys',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'coalition',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'tally',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
      'fold',
    ]);
  });

  it('name ten keys, each derived as a second implementation (WebCrypto) derives it', async () => {
    expect([...SEEDS.keys()]).toEqual([
      'ana',
      'ben',
      'cal',
      'dee',
      'kim',
      'zed',
      'eve',
      'fay',
      'gus',
      'hal',
    ]);
    for (const [name, seed] of SEEDS) {
      const pkcs8 = concat(fromHex('302e020100300506032b657004220420'), seed);
      const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
      const { x } = await crypto.subtle.exportKey('jwk', key);
      expect(publicKeyNamed(name)).toBe(x);
    }
  });

  it('name every vector uniquely', () => {
    const names = Object.values(VECTOR_FILES).flatMap((file) =>
      'vectors' in file ? file.vectors.map((vector) => vector.name) : [],
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it.each([
    'pass at an average of exactly 2.0',
    'fail at exactly 10% zeros',
    'lapse below quorum',
    'a 2-member group passes with 2 of 2 ballots',
    'a three-way tie goes to the earliest version',
    'at 11 eligible, 3 scorers lapse',
    'at 11 eligible, 4 scorers meet quorum',
    'at 15 eligible, 4 scorers lapse',
    'at 15 eligible, 5 scorers meet quorum',
    'entrenched pass at an average of exactly 3.0',
    'entrenched fail at exactly 5% zeros',
    'entrenched pass with 21 scorers and one 0',
    'an average of exactly 2.5 with no zeros fails the entrenched bar',
    'an average of exactly 2.5 with no zeros passes the ordinary bar',
    'entrenched lapse below quorum',
    'priority-rank: of four options, A and B pass and tie on average and zeros, so A, the earlier, comes first; C is below quorum and D fails the floor',
    'priority-rank: the higher average ranks first, wherever it sits on the ballot',
    'priority-rank: an equal average ranks the option with fewer zeros first, then the earlier option',
    'priority-rank: two options, one at exactly 2.0 and one just under, rank only the one at 2.0',
    'priority-rank: seven options, of which the three that clear the floor and quorum rank by average',
    'priority-rank: options at quorum that all miss the floor rank nothing, and the vote fails',
    'priority-rank: options that all miss quorum rank nothing, and the vote lapses',
  ])('include the tally vector "%s"', (name) => {
    expect(TALLY_VECTORS.map((vector) => vector.name)).toContain(name);
  });

  it.each([
    'a 2-member group passes with 2 of 2 ballots, which closes it early',
    'an early close once everyone has scored; a ballot after the close is ignored',
    'an event with v: 2 is ignored and leaves state unchanged',
    'an event that refers to an ignored event is ignored too',
    'a Proposal whose author ts is 7 days old is still open a minute before its relay deadline',
    'a Proposal whose author ts is 7 days old closes when relay time reaches its deadline',
    "a ballot received after the deadline doesn't count whatever its ts says, nor displace an earlier one",
    'a forged genesis before the real one founds nothing, and the real one founds the group',
    "one byte flipped in the event bytes is ignored, and can't shadow the real event after it",
    "one byte flipped in the signature is ignored, and can't shadow the real event after it",
    "one byte flipped in the key is ignored, and can't shadow the real event after it",
    "a member's real signature under another member's key is ignored",
    "a record whose key isn't the event's author is ignored, and can't shadow the author's own",
    'a Proposal validly signed by a key that never joined is ignored',
    "replay-join-other-group: Kim's join, signed for group A, is ignored in group B",
    'a second genesis, validly signed by a member, is ignored',
    "a small-order key, whose signature holds for every message, can't join",
    "a non-canonical encoding of a small-order key can't join either",
    'a bare event with no key or signature, as the stub era posted, is ignored and shadows nothing',
    "re-posting a member's older ballot as identical signed bytes, after their newer one, changes neither the outcome nor which ballot counts",
    'genesis makes the founder a Co-Creator, a join with no level folds as a Collaborator, and a join keeps the level it names',
    "a join that names an unknown level, such as admin, is ignored, so its author can't vote",
    "a Member's proposal and vote are ignored, and a Member isn't in the eligible set",
    "a Collaborator's vote counts, but their proposal is ignored",
    "a Co-Creator's proposal and vote both count",
    "a level event sets its author's own level at once: a Collaborator steps up and proposes, and the founder steps down and can't",
    'a level event is ignored from a non-member, for an unknown level, for the level its author already holds, or for another group',
    "levels-step-up-after-open: Kim joins as a Member, a Proposal opens, then Kim steps up to Collaborator and votes; the ballot is ignored and Kim isn't waited for",
    "a Collaborator's ballot cast before they step down to Member still counts, and one received after doesn't",
    'stepping down never touches an open Proposal: its eligible set and quorum stay 3, so 2 ballots lapse at the deadline',
    "someone in a Proposal's eligible set who steps down and back up before its deadline can still vote on it",
    "in a group of 5 with 2 Members, a Proposal's eligible count is 3 and its quorum is 3, so 2 ballots lapse at the deadline",
    "in a group of 5 with 2 Members, the 3 voting members' ballots meet quorum and close the vote early",
    'passes that close in the same minute apply in the relay order of their Proposals',
    "a version joins the open Proposal's ballot under its own event id, in relay order",
    'a fourth version is ignored, and the ballot keeps the first three',
    'a version received a minute before the deadline joins the ballot, and one received at the deadline is ignored',
    'a version received after an early close is ignored, even in the same minute',
    'a version needs an author who holds propose, so not a Collaborator, and a Proposal to join',
    'a ballot that names a version not yet on its Proposal is ignored, and stays ignored once the version arrives',
    "a voter's latest ballot replaces their earlier one in full, so a version it leaves out loses their score",
    "when both versions pass, the one with the higher average becomes the Atom's text",
    'a version added after the others had scored keeps the vote open until every voter has scored it too',
    "every voter's score for version 1 doesn't close the vote while one of them hasn't scored version 2",
    'a second Proposal on an Atom whose first is still open is ignored, and so are its ballots',
    "a Proposal on another Atom opens while the first Atom's is still open",
    'a second Proposal on the same Atom opens once the first has closed early, even in the same minute',
    "a second Proposal on the same Atom is ignored a minute before the first one's deadline, and opens at it",
    "a late version scored 4 by only 2 of 10 eligible members can't win, because it never reaches quorum",
    'a three-version tie goes to the earliest version',
    'a tie between later versions goes to the one the relay received first, whatever their ts',
    "a passed add lands right after its anchor, as a new Atom of the same Document whose id is the Proposal's",
    'an add with after: null lands first',
    "an add whose anchor isn't in the Document when it's made is ignored, and one made once the anchor's own add has passed lands after it",
    "an add or a version of one whose text is empty is ignored, and an add's versions compete on its ballot as an edit's do",
    'a Proposal on an added section is ignored until its add passes, and changes it after',
    "an add runs the voting window its proposer chose, and one outside its class's bounds is ignored",
    'a passed removal deletes its Atom, and the fold then ignores a Proposal on it and an add anchored on it',
    'a removal and a rewording of one Atom share one ballot; when the removal wins, only it applies, and the fold ignores a later Proposal on the Atom',
    'when a rewording beats a removal on one ballot, only the rewording applies and the section stays in its place',
    'a removal that fails leaves its section in place',
    'a removal that passes at its deadline takes its Atom out from that minute, so a Proposal on it or anchored on it received then is ignored',
    'sections-anchor-removed: the Atoms are [A, B, C]; P1 adds D after B and P2 removes B; P2 closes early, before P1 reaches its deadline, so the Document ends as [A, C, D]',
    'passes apply in order of close time, not relay order: of two adds on one anchor, the one that closes later ends directly after it',
    "adds that close in the same minute apply in their Proposals' relay order, whatever order their closing ballots came in",
    'sections-dissolve: an add and a removal still open when the group dissolves never close or apply, even once relay time passes their deadlines; an add that passed before it keeps its section, and an add, a ballot and a version on a section change after it are ignored',
    "sections-rotate: after a key change, a ballot on a removal and an add read from epoch 0's mailbox change nothing; the add's copy in epoch 1's opens once, the removal opened in epoch 0 closes on epoch 1's ballots, and both apply",
    "sections-admission: a newcomer still earning voting rights can't propose an add or a removal, put a removal on a ballot or score an add, and isn't eligible on one; from the minute their rights arrive they propose a removal, and their ballot counts toward closing it",
    'a genesis without rules folds with DEFAULT_RULES',
    "a Proposal's class is ordinary and its deadline is its received plus 7 × 1,440 minutes",
    'a genesis that writes DEFAULT_RULES out in full, as Create group does, folds with them',
    'a genesis whose entrenched avgAtLeast is 1 forms no group',
    'a Proposal that writes its own class, bar and deadline is still ordinary: 7 days, and a 2.5 average passes',
    'window-ordinary-min: a window of 3 days, the ordinary minimum, opens the Proposal and its deadline is received + 4,320',
    'window-ordinary-max: a window of 14 days, the ordinary maximum, opens the Proposal and its deadline is received + 20,160',
    'window-below-min: a window of 2 days, under the ordinary minimum, makes the fold ignore the Proposal',
    'window-above-max: a window of 15 days, over the ordinary maximum, makes the fold ignore the Proposal',
    'window-fraction: a window of 7.5 days makes the fold ignore the Proposal, as windows are whole days',
    'window-string: a window of "7", a string, makes the Proposal a bad shape, so the fold ignores it',
    'window-default: a Proposal with no window runs the ordinary default, so its deadline is received + 10,080',
    'window sets the deadline: a window of 10 days gives a deadline of received + 14,400',
    'a 10-day Proposal whose author ts is 10 days old is still open, and takes a ballot, a minute before its relay deadline',
    'a 10-day Proposal whose author ts is 10 days old closes when relay time reaches its deadline, 10 full days after receipt',
    'a 14-day vote still closes early once every eligible member has scored, and its deadline stays received + 20,160',
    'steward-founder-seat: the founder holds seat 1 at genesis with no term end, and seat 2 starts empty',
    'a steward Proposal is ignored at 2 people holding voting rights, even with a newcomer following too',
    'a steward Proposal is accepted at 3 people holding voting rights, even when one of them chose Member (ADR-0075 §3)',
    'a steward Proposal is accepted at 3 voting members: ordinary, 7 days, one version with no text',
    'a Proposal for seat 2 is ignored at 5 voting members',
    'a Proposal for seat 2 is accepted at 6 voting members',
    'a pass seats the nominee in seat 1 with term end = close + 262,080 minutes',
    "seat 2's first-ever term is 131,040 minutes from the close, so the seats come due apart",
    "steward-recall: a recall empties the seat, and the recalled steward's own ballot on it is ignored",
    'a step down to Member empties the seat, and the former steward can no longer suspend',
    'a holder past their term end keeps the seat and can still suspend, and the founder they replaced cannot',
    'a suspend from a non-steward, even a Co-Creator, is ignored',
    'a self-suspension is ignored, and so is a suspend of someone who is not a member',
    'a suspend by a suspended steward is ignored, and the suspended steward keeps the seat',
    'a second suspension of the same person within 30 days of the first one ending is ignored',
    'a second active suspension by the same steward is ignored until the first one ends',
    'a suspend from a steward facing an open recall is ignored, and allowed once the recall has closed',
    'a suspension 25 days after the previous one ended is ignored, and one 31 days after it is accepted',
    'suspend-lapse: a steward suspends Kim at minute 2,000,000; her ballot at 2,005,000 is ignored and her ballot from 1,999,000 still counts; her ballot on another Proposal at 2,010,080 counts',
    "a suspended member's proposal, level, version and vote are ignored, yet they stay eligible on a Proposal that opens meanwhile, which can't close early without them",
    'two-open-proposals: P2 opens on a Monday and P1 on the Tuesday, so P2 closes first; Ben has scored P1 only, and Cal joins after both opened',
    "leave-ballot-after: a ballot received after its author's leave is ignored, though its ts is earlier",
    "leave-ballot-before: a ballot received before its author's leave still counts, so the others' ballots close the vote early",
    "leave-open-unchanged: a leave never touches an open Proposal: its eligible set and quorum stay 3, so it doesn't close early and 2 ballots lapse at the deadline",
    "leave-eligible-after: the leaver isn't eligible on a Proposal opened after the leave, so the 3 who stay close it early",
    "leave-proposal-tallies: the leaver's open Proposal and their version on another stay on the ballot, tally and pass at the deadline",
    'leave-after: once someone has left, their join, level, proposal, version and second leave are all ignored',
    'leave-ignored: a leave from someone who never joined, or for another group, is ignored',
    'leave-founder: the founder can leave too, and the group carries on: the others still propose and vote',
    "leave-steward: a steward's leave empties their seat, and a suspend they send after it is ignored",
    "leave-suspended: a suspended member's leave is honored though their level change is ignored, and the suspension stays on record",
    'window-steward: a steward Proposal that writes a window of 10 still runs the ordinary default, 7 days',
    "result-mismatch: with 2 eligible, Ana scores 4 and Ben 0 with a reason; Ben's result counting two 4s is ignored and flagged, and Ana's [1,0,0,0,1] is canonical",
    "a result whose commit doesn't match this device's ballots is ignored and flagged",
    "a result whose closedAt isn't the close this device's ballots give is ignored and flagged",
    "a result whose outcome its own counts don't give is ignored and flagged, even when its counts match",
    "a result whose eligible count isn't the Proposal's is ignored and flagged",
    "a result naming versions the Proposal doesn't have is ignored and flagged",
    "a result received before the close is ignored, and isn't flagged",
    "a result received in the close's own minute, after the closing ballot, is ignored, and isn't flagged",
    "a result from someone who isn't a member is ignored, and isn't flagged",
    'the first valid result in relay order wins, and a later valid one is ignored',
    'a mismatching result after the canonical one is ignored and still flagged',
    'a Proposal that closes at its deadline takes a result whose closedAt is the deadline, received after it, not in it',
    'a result claiming a pass on a Proposal nobody voted on is ignored and flagged, and the Proposal lapses',
    'a result claiming a pass on a Proposal in cleared is taken as it stands, and the Atom changes',
    'a zero-count lapse is the canonical result of a Proposal nobody voted on',
    'a Proposal in cleared takes its outcome and early close from its result, and its pass applies',
    "with the ballots held, a version in the early close's minute but after the closing ballot is ignored, as is one after",
    "with the ballots cleared, a version in the early close's minute joins only if the result lists it, and one after is ignored",
    "with the ballots held, a second Proposal on the same Atom opens in the minute of the first's early close, after the closing ballot",
    "with the ballots cleared, a second Proposal on the same Atom opens in the minute of the first's early close, before the result arrives",
    'for a Proposal in cleared, a ballot left in the log is ignored, and only the first result counts',
    "for a Proposal in cleared, a result from someone who isn't a member is ignored, so it neither closes nor decides it",
    "for a Proposal in cleared, a result received in its own close's minute is ignored, so it neither closes nor decides it",
    "for a Proposal in cleared, a result whose outcome its counts don't give is ignored",
    'for a Proposal in cleared, an early close whose counts leave an eligible voter out is ignored',
    'turning the chat bot on is entrenched: its deadline is received plus 14 × 1,440 minutes, and an average of 2.5 with no zeros fails it',
    'turning the chat bot on passes at the entrenched bar and sets its webhook, and turning it off again is ordinary: received plus 7 × 1,440 minutes',
    'replacing one webhook with another is ordinary, so an average of 2.5 passes it and sets the new webhook',
    'opening the front door is entrenched and closing it is ordinary, so an average of 2.5 closes it again',
    'a rules Proposal that writes its own class, bar, deadline, text and from is still entrenched for 14 days, and an average of 2.5 fails it',
    'turning the chat bot on with a voting window of 13 days is ignored, and 14 days opens it, running received plus 14 × 1,440 minutes',
    'turning the chat bot off takes the ordinary bounds, so 15 days is ignored and 3 runs 3 × 1,440 minutes, and opening the front door may run 28 days',
    'a rules Proposal is ignored for a webhook off Discord, over http:, with a query or with another field, for a bare URL, for an unknown opt-in, and for a front door that is neither true nor false',
    'a rules Proposal for the value that stands is ignored: the chat bot off, or the front door closed, while each already is',
    'once the chat bot is on, a rules Proposal for the same webhook is ignored',
    'a second rules Proposal for an opt-in is ignored while the first is open, one for the other opt-in opens, and the second opens in the minute the first closes early',
    "a Collaborator's rules Proposal is ignored, and so are a version of a rules Proposal and a ballot that scores it",
    'a genesis that founds its group with the front door open, or the chat bot on, forms no group; one with both off does',
    'a narrow from a Co-Creator who holds no steward seat is ignored, even beside their own open off-Proposal',
    "a steward's narrow is ignored with no off-Proposal of their own open: beside a closed on-Proposal, or beside someone else's off-Proposal",
    "a steward's narrow beside their own off-Proposal turns the chat bot off at once while the rules still hold it on, and a second narrow while it's in force is ignored",
    "the chat bot stays off for good once the steward's off-Proposal passes",
    "the chat bot comes back on in the minute the steward's off-Proposal closes when it fails",
    "the chat bot comes back on at the steward's off-Proposal's deadline when nobody votes and it lapses",
    'after the group turns an off-Proposal down, a narrow 30 × 1,440 minutes later is ignored and one a minute after that holds',
    'a narrow from a steward facing an open recall is ignored',
    "a steward closes the front door at once the same way, and the chat bot isn't touched",
    'a recovery-share from someone who never joined, with no box text, or from someone who has left is ignored and changes nothing',
    'a recovery-share from a member changes no Atom, Proposal or member: the fold keeps each one, opaque, in relay order, and the Proposal around them passes as it would without them',
    "a suspended member's recovery-share still counts: it governs nothing, so the suspension that ignores their proposal leaves it in",
    'priority-options: a priority vote with 2 options opens, each option a version with the id `${proposalId}.${i}`, and no text of its own',
    'priority-options: a priority vote with 7 options opens',
    'priority-options: a priority vote with 1 option is ignored, and so is one with 8',
    'priority-options: an option of 121 code points is ignored, and one of exactly 120 opens, though it takes 240 UTF-16 units',
    'priority-options: a priority vote with two equal options is ignored, and so is one with a blank or empty option',
    'priority-options: a second priority vote while one is open is ignored, and one opens once the first has closed early, even in the same minute',
    'priority-options: an edit Proposal opens beside an open priority vote',
    'priority-options: a priority vote\'s window of 3 days sets its deadline to received + 4,320; one of 15 days is ignored, and one of "7", a string, holds no event',
    'priority-options: a version on a priority vote is ignored, so its options stay as proposed',
    "priority-options: a Collaborator's priority vote is ignored, since asking needs propose",
    'priority-options: a priority vote that also names an Atom or text, lacks options, has a non-string option or list, or names an unknown target holds no event, and one with an empty question is ignored',
    'priority-focus: of four options, Fix the website and Plan the picnic pass and tie, so the earlier, Fix the website, becomes the focus, and every Atom stays byte-identical',
    'priority-focus: a priority vote whose top option passes sets no focus until its pass is final',
    'priority-focus: a later priority vote that lapses leaves the focus unchanged',
    'priority-focus: a later priority vote in which no option passes leaves the focus unchanged',
    'priority-focus: a later priority vote that passes replaces the focus with its top option',
    'priority-focus: an edit that passes after a priority vote changes its Atom and leaves the focus',
    'priority-focus: a group whose only priority vote fails has no focus',
    "dissolve-terminal: Ana, Ben and Cy pass a dissolve with three 4s, which closes it early at 30,000,000; Ana's dissolve at 30,000,001 ends the group, so Ben's ballot on the other open Proposal at 30,000,002 and a join at 30,000,003 are ignored, and that Proposal has no outcome",
    'dissolve-bar: a dissolve Proposal averaging exactly 2.5 with no zeros fails, because it is entrenched, so a dissolve naming it is ignored and the group goes on',
    'dissolve-open: a dissolve naming a dissolve Proposal that is still open is ignored, and the ballot that closes it still counts',
    'dissolve-lapsed: a dissolve naming a dissolve Proposal that lapsed below quorum at its deadline is ignored',
    'dissolve-edit: a dissolve naming a passed edit, which is not a dissolve Proposal, is ignored',
    "dissolve-first: a dissolve from someone who never joined, or naming no Proposal, is ignored; the first valid one ends the group with the vote's wipe, and a second is ignored",
    'dissolve-proposal: a dissolve Proposal is entrenched, runs 14 days, has one version with no text and keeps its wipe; a version on it, and a second dissolve Proposal while it is open, are ignored',
    'dissolve-proposal-again: once a dissolve Proposal has closed, another opens, even in the same minute',
    "dissolve-proposal-collaborator: a Collaborator's dissolve Proposal is ignored, as proposing needs propose",
    'dissolve-proposal-shape: a dissolve Proposal whose wipe is missing or not true or false, or that names an Atom, is a bad shape, so the fold ignores it',
    'dissolve-window-min: a dissolve window of 13 days, under the entrenched minimum, is ignored, and 14 opens it with a deadline of received + 20,160',
    'dissolve-window-max: a dissolve window of 29 days, over the entrenched maximum, is ignored, and 28 opens it with a deadline of received + 40,320',
    'dissolve-unfinished: an edit and a steward election still open when the group dissolves never close, apply or seat, even once later records and relay time pass their deadlines, and a Proposal decided before keeps its outcome and its text',
  ])('include the fold vector "%s"', (name) => {
    expect(FOLD_VECTORS.map((vector) => vector.name)).toContain(name);
  });

  it.each([
    'door-invited-first',
    'door-invited-ignored',
    'door-count',
    'door-rotate',
    'door-shape',
  ])('include the front door vector "%s" (#121)', (name) => {
    expect(FOLD_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(name);
  });

  it.each([
    "invite-token-member: a token a member signed over the group id names them as the joiner's inviter",
    "invite-token-non-member: a token from someone who isn't a member gives a valid join with no inviter",
    "invite-token-other-group: a member's token over another group's id gives a valid join with no inviter",
    "invite-token-event-tag: a member's signature over the group id under the event tag gives a valid join with no inviter",
    'invite-token-forged: a token naming a member but signed by someone else gives a valid join with no inviter',
    'invite-token-joined-later: a token from someone who joins after the joiner names no one',
    'invite-token-chain: a member who joined by invite names the next joiner',
    'invite-token-malformed: a token of the wrong shape gives a valid join with no inviter',
    'invite-token-none: a join with no token, as the tracer made, names no inviter',
  ])('include the invite vector "%s"', (name) => {
    expect(FOLD_VECTORS.map((vector) => vector.name)).toContain(name);
  });

  it.each([
    'vouch-wait-boundary',
    'vouch-second-after-wait',
    'vouch-ignored',
    'vouch-for-former',
    'vouch-co-creator-waiting',
    'vouch-rights-stay',
    'vouch-voucher-leaves',
    'bootstrap-first-three',
    'bootstrap-after-leave',
    'bootstrap-member-churn',
  ])('include the admission vector "%s" (#101)', (name) => {
    expect(FOLD_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(name);
  });

  it.each([
    'removal-target-ineligible',
    'removal-average-2.5',
    'removal-one-zero',
    'removal-lapse',
    'removal-proposal',
    'removal-proposal-who',
    'removal-proposal-shape',
    'removal-dissolved',
    'removal-response-length',
    'removal-response-who',
    'removal-response-after-close',
    'removal-response-deadline',
    'removal-response-last-minute',
    'removal-response-suspended',
    'removal-remove-first',
    'removal-remove-suspended',
    'removal-ballot-before',
    'removal-steward-seat',
    'removal-pending-only-leave',
    'removal-rotate',
    'removal-suspension-day-6',
    'removal-suspension-failed',
    'removal-suspension-none',
    'removal-suspension-early-fail',
    'removal-suspension-opened-before',
    'removal-suspension-opened-before-closes-early',
  ])('include the removal vector "%s" (#115)', (name) => {
    expect(FOLD_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(name);
  });

  it.each([
    'proposal-number',
    'chat-thread-first',
    'chat-thread-ignored',
    'chat-thread-narrowed',
    'chat-thread-off',
  ])('include the Discord thread vector "%s" (#123)', (name) => {
    expect(FOLD_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(name);
  });

  it.each([
    'removal pass with 20 scorers and one 0',
    'removal fail with two 0s among 10 scorers',
    'removal pass with 41 scorers and two 0s',
    'removal fail with two 0s among 40 scorers, exactly 5%',
    'removal fail at an average of 2.99',
    'removal pass at an average of exactly 3.0 among 100 scorers',
    'a dissolve’s entrenched bar still fails 20 scorers with one 0',
    'an average of exactly 2.5 with no zeros fails the removal bar',
  ])('include the removal bar vector "%s" (#115)', (name) => {
    expect(TALLY_VECTORS.map((vector) => vector.name)).toContain(name);
  });

  it.each([
    'dispatch-co-creator',
    'dispatch-rights',
    'dispatch-level',
    'dispatch-title',
    'dispatch-text',
    'dispatch-doc',
    'dispatch-carried-pass',
    'dispatch-carried-open',
    'dispatch-carried-lapse',
    'dispatch-carried-fail',
    'dispatch-carried-invalid',
    'dispatch-carried-close-order',
    'dispatch-carried-same-deadline',
    'dispatch-carried-dissolve',
  ])('include the Dispatch vector "%s" (#112)', (name) => {
    expect(FOLD_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(name);
  });

  it.each([
    'sections-dispatch-add',
    'sections-dispatch-remove',
    'sections-dispatch-added-edit',
    'sections-dispatch-ignored',
  ])('include the sections Dispatch vector "%s" (#75, #112)', (name) => {
    expect(FOLD_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(name);
  });

  it('include the sections vector "sections-coalition" (#75, #100)', () => {
    expect(COALITION_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(
      'sections-coalition',
    );
  });

  it('include the sections vector "sections-chat-thread" (#75, #123)', () => {
    expect(FOLD_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(
      'sections-chat-thread',
    );
  });

  it.each([
    'priority-chat-thread',
    'priority-dispatch-pass',
    'priority-dispatch-lapse',
    'priority-dispatch-ignored',
    'priority-dissolve',
    'priority-suspend',
    'priority-admission',
    'priority-cleared',
    'priority-cleared-fail',
  ])(
    'include the priority vote vector "%s" (#107 with #101, #102, #108, #111, #112, #123)',
    (name) => {
      expect(FOLD_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(name);
    },
  );

  it('include the priority vote vector "priority-coalition" (#107, #100)', () => {
    expect(COALITION_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(
      'priority-coalition',
    );
  });
});

describe('coalition vector files (#100)', () => {
  it.each([
    'formation-formed',
    'formation-declined',
    'formation-forming-motion',
    'formation-atoms-differ',
    'threshold-4',
    'threshold-5-pass',
    'threshold-5-fail',
    'threshold-6',
    'forgery-other-seat',
    'forgery-join-no-proof',
    'forgery-join-other-coalition',
    'forgery-join-other-joiner',
    'forgery-repeat',
    'forgery-extra-key',
    'forgery-vote',
    'forgery-motion-dispatch',
    'contest-pass-then-fail',
    'contest-fail-then-pass',
    'group-join-after',
    'group-lapse',
    'group-deadline-final',
    'group-mismatch',
    'group-motion-number',
    'group-motion-chat',
    'group-motion-dispatch',
    'admit-pass',
    'admit-open',
    'admit-fail',
    'admit-every-seat',
    'forgery-admit-proof',
    'forgery-admit-participant',
    'forgery-admit-seat',
    'forgery-admit-repeat',
    'forgery-admit-dispatch',
    'forgery-admit-in-group',
    'forgery-admit-genesis-result',
    'forgery-admit-forming',
  ])('include "%s"', (name) => {
    expect(COALITION_VECTORS.map((vector) => vector.name.split(':')[0])).toContain(name);
  });

  it('pin every forgery and ignored event as a removal that changes nothing', () => {
    const forgeries = COALITION_VECTORS.filter((vector) => vector.name.startsWith('forgery-'));
    expect(forgeries.length).toBeGreaterThan(10);
    for (const vector of forgeries) {
      expect(Object.values(vector.unchangedWithout ?? {}).flat(), vector.name).not.toEqual([]);
    }
  });
});

describe('tally vectors', () => {
  it.each(TALLY_VECTORS.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const bar = DEFAULT_RULES.bars[vector.bar ?? 'ordinary'];
    const { eligible, versions } = vector;
    expect(tally({ eligible, versions, bar })).toEqual({ ...vector.expect, bar });
    if (vector.rank !== undefined) {
      expect(rank({ eligible, versions, bar }).map((option) => option.id)).toEqual(vector.rank);
    }
  });
});

describe('coalition vectors (#100)', () => {
  it.each(COALITION_VECTORS.map((vector) => [vector.name, vector] as const))(
    '%s',
    (_name, vector) => {
      const { logs, ids } = buildLogs(vector);
      const states = foldLogs(logs, vector.relayNow);
      for (const [log, expected] of Object.entries(vector.expect)) {
        expect(folded(states, log).state, log).toMatchObject(resolve(expected, ids) as object);
      }
      for (const [log, expected] of Object.entries(vector.report ?? {})) {
        expect(crossings(states, log).report, log).toEqual(resolve(expected, ids));
      }
      for (const [log, expected] of Object.entries(vector.mismatches ?? {})) {
        expect(crossings(states, log).mismatches, log).toMatchObject(resolve(expected, ids) as []);
      }
      for (const [log, seqs] of Object.entries(vector.unchangedWithout ?? {})) {
        const kept = (logs[log] ?? []).filter((record) => !seqs.includes(record.seq));
        const without = foldLogs({ ...logs, [log]: kept }, vector.relayNow);
        for (const name of Object.keys(states)) {
          const left = folded(without, name).state;
          expect({ ...left, ignored: [] }, name).toEqual({
            ...folded(states, name).state,
            ignored: [],
          });
        }
      }
    },
  );
});

describe('fold vectors', () => {
  it.each(FOLD_VECTORS.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const { records, ids, cleared } = buildRecords(vector);
    const state = fold(records, vector.relayNow, [], cleared);
    expect(state).toMatchObject(resolve(vector.expect, ids) as object);
    const without = vector.unchangedWithout ?? [];
    const kept = records.filter((record) => !without.includes(record.seq));
    // `ignored` always differs, and so may whatever `unchangedExcept` names (#109's recoveryShares).
    const apart = (folded: object): object =>
      Object.fromEntries(
        Object.entries(folded).filter(
          ([key]) => key !== 'ignored' && !(vector.unchangedExcept ?? []).includes(key),
        ),
      );
    expect(apart(fold(kept, vector.relayNow, [], cleared))).toEqual(apart(state));
  });
});
