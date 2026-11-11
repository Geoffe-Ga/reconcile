/**
 * Links a new test device to an existing one through the whole handshake
 * (#96, `link/session.ts`), on one fake relay: what a test of what a linked
 * device holds starts from. Nothing here syncs; the test does when it wants.
 */
import { parseLinkCode } from '../crypto/link';
import { joinLink, offerLink } from '../link/session';
import { testDevice, type TestDevice } from './appServices';
import type { FakeRelay } from './fakeRelay';

/**
 * Opens device `name` on `fake` and links it to `from`: the code, both keys,
 * one Match on `from`, then the bundle. Resolves once the new device holds
 * the groups.
 *
 * @throws {Error} when any step doesn't go as a link should.
 */
export async function linkDevice(
  fake: FakeRelay,
  from: TestDevice,
  name: string,
): Promise<TestDevice> {
  const to = await testDevice(fake, name);
  const offer = offerLink(from.services);
  const code = parseLinkCode(offer.code);
  if (code === null) throw new Error('Expected a code.');
  const join = await joinLink(to.services, code);
  await offer.poll();
  await join.poll();
  if ((await offer.confirm()) !== 'sent') throw new Error('Expected the bundle to go.');
  const step = await join.poll();
  if (step.kind !== 'linked') throw new Error(`Expected a link, not ${step.kind}.`);
  return to;
}
