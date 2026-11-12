/**
 * A second fold of an unchanged log checks no signature again (#362): a
 * sync pass folds each group about ten times, and every record's signature,
 * every join's invite token and every coalition join's seat proof in it
 * verified on the first. Each fold reads them as before; only the Ed25519
 * work is skipped, from the verdicts kept in memory (`./sign.ts`). It lives
 * here, beside the one Ed25519 call site, since only src/crypto counts the
 * library's calls (the architecture's only-crypto-imports-noble rule).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NestedLogs, threeLevels } from '../test/coalitions';
import type { TestDevice } from '../test/appServices';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { members } from '../test/members';
import { fold } from '../engine/fold';

// Count the real Ed25519 verifications.
vi.mock('@noble/curves/ed25519.js', async (importOriginal) => {
  const real = await importOriginal<{ ed25519: typeof ed25519 }>();
  return { ...real, ed25519: { ...real.ed25519, verify: vi.fn(real.ed25519.verify) } };
});

freshIndexedDBPerTest();

const opened: TestDevice[] = [];
afterEach(() => {
  for (const device of opened.splice(0)) device.services.store.close();
});

describe('a second fold of an unchanged log (#362)', () => {
  it('verifies no signature or invite token of a group whose members joined by invite', async () => {
    const { groupId, devices } = await members(createFakeRelay(), ['Ana', 'Ben', 'Cal', 'Dee']);
    opened.push(...devices);
    const group = await devices[0]?.services.store.getGroup(groupId);
    if (group === undefined) throw new Error('Expected the group.');
    const first = fold(group.log, group.relayNow);
    expect(first.members.map((m) => m.invitedBy !== null)).toEqual([false, true, true, true]);
    vi.mocked(ed25519.verify).mockClear();

    const again = fold(
      group.log.map((r) => ({ ...r, bytes: Uint8Array.from(r.bytes) })),
      group.relayNow,
    );

    expect(ed25519.verify).not.toHaveBeenCalled();
    expect(again).toEqual(first);
  });

  it('verifies no seat proof of three nested coalitions', () => {
    const logs = new NestedLogs();
    threeLevels(logs);
    const first = logs.foldAll(29_375_100);
    expect(ed25519.verify).toHaveBeenCalled();
    vi.mocked(ed25519.verify).mockClear();

    const again = logs.foldAll(29_375_100);

    expect(ed25519.verify).not.toHaveBeenCalled();
    expect(again).toEqual(first);
  });
});
