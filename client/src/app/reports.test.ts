/**
 * Reports and appeals on the app's services (#490): an appeal goes only for
 * a member who may propose in a group that lists its open door, whatever
 * the screen showed, and neither goes while the app pins no steward.
 */
import { LEVELS } from '../engine/capabilities';
import { describe, expect, it } from 'vitest';

import { createRelay } from '../net/relay';
import { stewardInboxOf } from '../crypto/shelf';
import { createFakeRelay } from '../test/fakeRelay';
import { LISTED, DOOR } from '../test/door';
import { authorOf } from '../test/keys';
import { TEST_STEWARD } from '../test/steward';
import { groupLog, type LogBuilder } from '../test/votes';
import { appealFrom, reportEntry, stewardPinned } from './reports';

/** The level that votes but doesn't propose. */
const [, VOTING] = LEVELS;

const INBOX = stewardInboxOf(TEST_STEWARD.box.publicKey);
const ENTRY = 'E'.repeat(43);

/** Ana, Ben and Cal, whose front door everyone votes to `door`. */
function opened(door: unknown = LISTED): LogBuilder {
  const log = groupLog({ members: ['Ben', 'Cal'] });
  const proposal = log.rules('Ana', 'frontDoor', door, { title: 'The front door' });
  for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
  log.minute += 1;
  return log;
}

/** A store holding `log`'s group as `me`'s copy, under the id `g`. */
const storeOf = (log: LogBuilder | null, me = 'ana') => ({
  getGroup: (id: string) =>
    Promise.resolve(
      log === null || id !== 'g'
        ? undefined
        : ({
            log: [...log.records],
            relayNow: log.minute,
            cleared: [],
            me: { author: authorOf(me) },
          } as never),
    ),
});

describe('stewardPinned', () => {
  it('is true only while the app pins a steward', () => {
    expect(stewardPinned()).toBe(true);
    expect(stewardPinned(null)).toBe(false);
  });
});

describe('appealFrom', () => {
  it('sends an appeal for a member who may propose in a listed group', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });

    expect(await appealFrom({ relay, store: storeOf(opened()) }, 'g', ENTRY, 'Look again')).toBe(
      'sent',
    );
    expect(fake.blobs(INBOX)).toHaveLength(1);
  });

  it('sends nothing for an unknown group, an unlisted door, or a member who can’t propose', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const narrowed = opened();
    narrowed.level('Ben', VOTING);

    expect(await appealFrom({ relay, store: storeOf(null) }, 'g', null, 'Look')).toBe('failed');
    expect(await appealFrom({ relay, store: storeOf(opened(DOOR)) }, 'g', null, 'Look')).toBe(
      'failed',
    );
    expect(await appealFrom({ relay, store: storeOf(narrowed, 'ben') }, 'g', null, 'Look')).toBe(
      'failed',
    );
    expect(fake.requests).toEqual([]);
  });
});

describe('reportEntry', () => {
  it('sends the report with its note', async () => {
    const fake = createFakeRelay();
    const relay = createRelay({ fetch: fake.fetch });
    const report = { address: 'A'.repeat(43), id: ENTRY, clause: 'C1' } as const;
    expect(await reportEntry({ relay }, report, 'Spam')).toBe('sent');
    expect(fake.blobs(INBOX)).toHaveLength(1);
  });
});
