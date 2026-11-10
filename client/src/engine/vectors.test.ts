/**
 * Golden vectors: the engine's contract (ADR-0073, docs/spec/phase-1-spec.md §3–§5).
 *
 * src/test/vectors.ts reads each file in vectors/ and builds its records; its
 * header documents the format. This file runs every tally and fold vector.
 */
import { describe, expect, it } from 'vitest';

import { concat, fromHex } from '../test/bytes';
import {
  buildRecords,
  FOLD_VECTORS,
  publicKeyNamed,
  resolve,
  SEEDS,
  TALLY_VECTORS,
  VECTOR_FILES,
} from '../test/vectors';
import { fold } from './fold';
import { DEFAULT_RULES } from './rules';
import { tally } from './tally';

describe('vector files', () => {
  it('are the keys, then tally, fold or atom-text files', () => {
    expect(Object.keys(VECTOR_FILES).sort()).toEqual([
      'atom-text.json',
      'bars-entrenched-edges.json',
      'bars-ordinary-pairs.json',
      'fold.json',
      'home-two-open-proposals.json',
      'keys.json',
      'leave-ballots.json',
      'leave-eligibility.json',
      'leave-events.json',
      'levels-capabilities.json',
      'levels-eligible-count.json',
      'levels-step-down.json',
      'levels-step-up-after-open.json',
      'rules-class-forged.json',
      'rules-genesis-defaults.json',
      'rules-genesis-differs.json',
      'rules-genesis-missing.json',
      'signatures.json',
      'tally.json',
      'time.json',
      'versions-ballot.json',
      'versions-early-close.json',
      'versions-late-low-quorum.json',
      'versions-one-open.json',
      'versions-tie.json',
    ]);
    expect(Object.values(VECTOR_FILES).map((file) => file.kind)).toEqual([
      'atom-text',
      'tally',
      'tally',
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
      'tally',
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
    'a genesis without rules folds with DEFAULT_RULES',
    "a Proposal's class is ordinary and its deadline is its received plus 7 × 1,440 minutes",
    'a genesis that writes DEFAULT_RULES out in full, as Create group does, folds with them',
    'a genesis whose entrenched avgAtLeast is 1 forms no group',
    'a Proposal that writes its own class, bar and deadline is still ordinary: 7 days, and a 2.5 average passes',
    'two-open-proposals: P2 opens on a Monday and P1 on the Tuesday, so P2 closes first; Ben has scored P1 only, and Cal joins after both opened',
    "leave-ballot-after: a ballot received after its author's leave is ignored, though its ts is earlier",
    "leave-ballot-before: a ballot received before its author's leave still counts, so the others' ballots close the vote early",
    "leave-open-unchanged: a leave never touches an open Proposal: its eligible set and quorum stay 3, so it doesn't close early and 2 ballots lapse at the deadline",
    "leave-eligible-after: the leaver isn't eligible on a Proposal opened after the leave, so the 3 who stay close it early",
    "leave-proposal-tallies: the leaver's open Proposal and their version on another stay on the ballot, tally and pass at the deadline",
    'leave-after: once someone has left, their join, level, proposal, version and second leave are all ignored',
    'leave-ignored: a leave from someone who never joined, or for another group, is ignored',
    'leave-founder: the founder can leave too, and the group carries on: the others still propose and vote',
  ])('include the fold vector "%s"', (name) => {
    expect(FOLD_VECTORS.map((vector) => vector.name)).toContain(name);
  });
});

describe('tally vectors', () => {
  it.each(TALLY_VECTORS.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const bar = DEFAULT_RULES.bars[vector.bar ?? 'ordinary'];
    const { eligible, versions } = vector;
    expect(tally({ eligible, versions, bar })).toEqual({ ...vector.expect, bar });
  });
});

describe('fold vectors', () => {
  it.each(FOLD_VECTORS.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const { records, ids } = buildRecords(vector);
    const state = fold(records, vector.relayNow);
    expect(state).toMatchObject(resolve(vector.expect, ids) as object);
    const without = vector.unchangedWithout ?? [];
    const kept = records.filter((record) => !without.includes(record.seq));
    expect({ ...fold(kept, vector.relayNow), ignored: [] }).toEqual({ ...state, ignored: [] });
  });
});
