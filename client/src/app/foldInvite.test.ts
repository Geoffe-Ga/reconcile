import { describe, expect, it } from 'vitest';

import { fold, type LogRecord } from '../engine/fold';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { foldInvite, genesisDocument } from './foldInvite';

const FIRST = 'Quiet after 10pm.';
const SECOND = 'Bins go out on Monday.';

/**
 * Ana, Ben, Cal and Dee, all voting. The first section's edit passes by early
 * close, when all four score it; the second's has three scores, the quorum,
 * so it stays open until its deadline.
 */
function twoPasses() {
  const log = groupLog({ members: ['Ben', 'Cal', 'Dee'] });
  const early = log.propose('Ana', { atom: 0, text: FIRST });
  for (const name of ['Ana', 'Ben', 'Cal', 'Dee']) log.vote(name, early, 4);
  const late = log.propose('Ana', { atom: 1, text: SECOND });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, late, 4);
  return { log, deadline: deadlineOf(START_MINUTE) };
}

const texts = (records: readonly LogRecord[], relayNow: number) =>
  foldInvite({ records, relayNow })?.map((atom) => atom.text);

describe('foldInvite', () => {
  it('reads the Document as it reads now: both passes, once the invite GET’s now reaches the deadline', () => {
    const { log, deadline } = twoPasses();
    expect(texts(log.records, deadline)).toEqual([FIRST, SECOND]);
  });

  it('leaves a section whose vote is still open as it reads, before that deadline', () => {
    const { log, deadline } = twoPasses();
    expect(texts(log.records, deadline - 1)).toEqual([FIRST, 'Bins go out on Tuesday.']);
  });

  it('dedupes a repeated record and skips bytes that don’t verify, as sync does', () => {
    const { log, deadline } = twoPasses();
    const [genesis, ...rest] = log.records;
    if (genesis === undefined) throw new Error('Expected a genesis.');
    const forged = Uint8Array.from(genesis.bytes);
    forged[forged.length - 1] = (forged.at(-1) ?? 0) ^ 1;
    const last = log.records.length;
    const noisy = [
      genesis,
      { seq: last + 1, received: genesis.received, bytes: forged },
      ...rest,
      { ...genesis, seq: last + 2 },
    ];
    expect(foldInvite({ records: noisy, relayNow: deadline })).toEqual(
      foldInvite({ records: log.records, relayNow: deadline }),
    );
  });

  it('finds no Document when the entries hold no genesis that verifies', () => {
    const { log, deadline } = twoPasses();
    expect(foldInvite({ records: [], relayNow: deadline })).toBeNull();
    expect(foldInvite({ records: log.records.slice(1), relayNow: deadline })).toBeNull();
  });
});

describe('genesisDocument', () => {
  it('takes only the Atoms of the genesis Document', () => {
    const state = groupLog().state();
    const other = { id: 'other.0', documentId: 'other', text: 'Another Document.' };
    const document = genesisDocument({ ...state, atoms: [...state.atoms, other] });
    expect(document?.map((atom) => atom.id)).toEqual([
      `${state.group ?? ''}.0`,
      `${state.group ?? ''}.1`,
    ]);
  });

  it('is null before any genesis', () => {
    expect(genesisDocument(fold([], null))).toBeNull();
  });
});
