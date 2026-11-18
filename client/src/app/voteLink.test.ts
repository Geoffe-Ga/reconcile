/**
 * Vote links (#472, ADR-0079): making a group's link for a Proposal, and
 * resolving a token across the device's groups. The properties pin that a
 * device finds the Proposal for every token it makes, and nothing for any
 * other 22-character string. The coalition test runs Riverside Tenants (Ana,
 * Cy) and Oak St Co-op (Ben, Cy) as Eastside Housing on a fake relay: one
 * motion gets a token of its own in each group, and Cy's device, in both,
 * opens each in its own group, while Ana's opens only Riverside's.
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { base64url } from '../crypto/base64url';
import { foldCoalitions } from '../store/coalitions';
import type { TestDevice } from '../test/appServices';
import { closeAll, formedCoalition, SLOW, syncAll } from '../test/coalitionDevices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { propose } from './proposals';
import {
  findVote,
  locateVote,
  readsAsVoteToken,
  tokenFor,
  VOTE_PREFIX,
  type VoteGroup,
  voteLinkOf,
} from './voteLink';

freshIndexedDBPerTest();

afterEach(() => {
  closeAll();
});

/** A 32-byte group secret. */
const secret = fc.uint8Array({ minLength: 32, maxLength: 32 });

/** An event id: 32 bytes in unpadded base64url. */
const eventId = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((bytes) => base64url(bytes));

/** A group a token may name: a secret and a few Proposals. */
const group = fc.record({
  groupId: eventId,
  secret,
  ids: fc.uniqueArray(eventId, { minLength: 1, maxLength: 4 }),
});

/** Groups as {@link findVote} reads them, from `group` samples. */
function asVoteGroups(
  samples: readonly { groupId: string; secret: Uint8Array; ids: readonly string[] }[],
): VoteGroup[] {
  return samples.map(({ groupId, secret: s, ids }) => ({
    groupId,
    secret: s,
    state: { proposals: ids.map((id) => ({ id })) as unknown as VoteGroup['state']['proposals'] },
  }));
}

/** Any 22 unpadded base64url characters. */
const anyToken = fc.uint8Array({ minLength: 16, maxLength: 16 }).map((bytes) => base64url(bytes));

describe('voteLinkOf (#472)', () => {
  it('is the origin, a slash and #vote/ before the token, with nothing else', () => {
    expect(voteLinkOf('https://app.example', 'A'.repeat(22))).toBe(
      `https://app.example/#vote/${'A'.repeat(22)}`,
    );
    expect(VOTE_PREFIX).toBe('#vote/');
  });
});

describe('readsAsVoteToken (#472)', () => {
  it('reads 22 base64url characters, and nothing shorter, longer or padded', () => {
    expect(readsAsVoteToken('k9V2'.repeat(5) + 'xY')).toBe(true);
    expect(readsAsVoteToken('A'.repeat(21))).toBe(false);
    expect(readsAsVoteToken('A'.repeat(23))).toBe(false);
    expect(readsAsVoteToken(`${'A'.repeat(21)}=`)).toBe(false);
    expect(readsAsVoteToken('')).toBe(false);
  });
});

describe('tokenFor (#472)', () => {
  it('gives no token for an id that isn’t an event id, so no link is offered', () => {
    expect(tokenFor(new Uint8Array(32), 'not an id')).toBeNull();
    expect(tokenFor(new Uint8Array(32), 'A'.repeat(43))).toHaveLength(22);
  });
});

describe('findVote (#472)', () => {
  it('finds the Proposal, in its own group, for every token the device makes', () => {
    // Each group's own secret; one id may stand in several groups, as one coalition motion does.
    const groups = fc.uniqueArray(group, {
      minLength: 1,
      maxLength: 3,
      selector: (g) => base64url(g.secret),
    });
    fc.assert(
      fc.property(groups, (samples) => {
        const voteGroups = asVoteGroups(samples);
        for (const { groupId, secret: s, ids } of samples) {
          for (const proposalId of ids) {
            expect(findVote(tokenFor(s, proposalId) ?? '', voteGroups)).toEqual({
              groupId,
              proposalId,
            });
          }
        }
      }),
    );
  });

  it('finds nothing for any other 22-character string', () => {
    fc.assert(
      fc.property(fc.array(group, { minLength: 1, maxLength: 3 }), anyToken, (samples, token) => {
        const made = samples.flatMap(({ secret: s, ids }) => ids.map((id) => tokenFor(s, id)));
        fc.pre(!made.includes(token));
        expect(findVote(token, asVoteGroups(samples))).toBeNull();
      }),
    );
  });

  it('finds nothing for a payload that isn’t a token, and nothing on a device with no group', () => {
    const groups = asVoteGroups([
      { groupId: 'g', secret: new Uint8Array(32), ids: ['A'.repeat(43)] },
    ]);
    expect(findVote('not a token', groups)).toBeNull();
    expect(findVote(tokenFor(new Uint8Array(32), 'A'.repeat(43)) ?? '', [])).toBeNull();
  });
});

/** Ana proposes new words for Eastside Housing's first section; the motion's id once every device has it. */
async function anaProposesMotion(ana: TestDevice): Promise<string> {
  const [entry] = await ana.services.store.listCoalitions();
  if (entry === undefined) throw new Error('Expected the coalition’s entry.');
  const coalitionId = foldCoalitions([entry])[0]?.state.group ?? '';
  const proposed = await propose(
    ana.services,
    entry.groupId,
    {
      atom: `${coalitionId}.0`,
      title: 'Banks too',
      why: 'The banks matter.',
      text: 'Everyone on the east side has a safe, warm home.',
      link: null,
    },
    coalitionId,
  );
  if (proposed.outcome !== 'proposed') throw new Error('Expected the motion to queue.');
  await syncAll(3);
  return proposed.proposalId;
}

/** `device`'s secret for `groupId`. */
async function secretOf(device: TestDevice, groupId: string): Promise<Uint8Array> {
  const stored = await device.services.store.getGroup(groupId);
  if (stored === undefined) throw new Error('Expected the group.');
  return stored.secret;
}

describe('locateVote (#472)', () => {
  it(
    'gives one coalition motion a token of its own in each group, and opens each in its own group',
    async () => {
      const fake = createFakeRelay();
      const { ana, cy, riverside, oak } = await formedCoalition(fake);
      fake.minute += 60;
      await syncAll(4);
      const motion = await anaProposesMotion(ana);

      const inRiverside = tokenFor(await secretOf(cy, riverside), motion) ?? '';
      const inOak = tokenFor(await secretOf(cy, oak), motion) ?? '';
      expect(inRiverside).toHaveLength(22);
      expect(inOak).toHaveLength(22);
      expect(inOak).not.toBe(inRiverside);

      // Cy is in both groups: each token opens the motion's ballot in its own group.
      await expect(locateVote(cy.services.store, inRiverside)).resolves.toEqual({
        groupId: riverside,
        proposalId: motion,
      });
      await expect(locateVote(cy.services.store, inOak)).resolves.toEqual({
        groupId: oak,
        proposalId: motion,
      });
      // Ana is in Riverside alone: Oak St's token is 22 random characters to her device.
      await expect(locateVote(ana.services.store, inRiverside)).resolves.toEqual({
        groupId: riverside,
        proposalId: motion,
      });
      await expect(locateVote(ana.services.store, inOak)).resolves.toBeNull();
    },
    SLOW.timeout * 2,
  );

  it('reads nothing from the store for a payload that isn’t a token', async () => {
    let reads = 0;
    const store = {
      listGroups: () => {
        reads += 1;
        return Promise.resolve([]);
      },
      listCoalitions: () => Promise.resolve([]),
    };
    await expect(locateVote(store, 'nope')).resolves.toBeNull();
    expect(reads).toBe(0);
  });
});
