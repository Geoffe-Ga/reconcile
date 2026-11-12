/**
 * A decided Proposal whose log also holds a forged `result` (#268), for the
 * tests that no forgery survives a device clearing its ballots (#111):
 * `store/expiry.forged.test.ts`, and the invite merge in
 * `app/actions.test.ts`.
 *
 * Ana proposes, the forger posts a fabricated result, and Ana and Ben, the
 * two members who hold `vote`, score the Proposal, closing it early. Then Ana
 * posts the result their ballots give: the genuine one. Cal is a Member, who
 * holds only `read`; Ben is a Co-Creator, who holds `vote`. Every record is
 * built through the engine (`groupLog`), never hand-written state.
 */
import { LEVELS } from '../engine/capabilities';
import { resultFor } from '../engine/expiry';
import type { ResultBody } from '../engine/event';
import type { LogRecord, Proposal } from '../engine/fold';
import type { Store } from '../store/db';
import { eventIdOf } from '../store/eventId';
import { testKeys } from './keys';
import { groupLog } from './votes';

/** The level that only follows, holding `read`: Cal's. */
const [MEMBER] = LEVELS;

/** Who forges: Cal, a Member who holds only `read`, or Ben, who holds `vote`. */
export type Forger = 'cal' | 'ben';

/**
 * What the forger posts:
 * - `invented`: a minute after the Proposal opens, counts nobody cast that
 *   close it in the minute it opened, with a fail. A cleared fold would read
 *   it ahead as the record if it survived clearing.
 * - `premature`: a minute after it opens, the record the ballots give then:
 *   none cast, so a lapse at the deadline. It matches the ballots as they
 *   stood, so only the check that a result arrives after the close refuses it.
 * - `mismatched`: after the close and before the genuine result, counts the
 *   ballots don't give, with a fail.
 */
export type Forgery = 'invented' | 'premature' | 'mismatched';

/** A signed record in the log, and its event id. */
export interface Posted {
  readonly id: string;
  readonly record: LogRecord;
}

/** The log of a decided Proposal with a forged result in it, in relay order. */
export interface ForgedLog {
  /** The group id: the genesis event's id. */
  readonly group: string;
  readonly records: readonly LogRecord[];
  /** The Proposal's id, which is also its one version's. */
  readonly proposal: string;
  /** The relay minute the second ballot closed it early. */
  readonly closedAt: number;
  /** The forger's record, and what kind of forgery it is. */
  readonly forged: Posted;
  readonly forgery: Forgery;
  /** Ana's result, which matches the ballots and arrives after the close. */
  readonly genuine: Posted;
}

/** A commitment to no ballot anyone cast: 32 zero bytes in base64url. */
const INVENTED_COMMIT = 'A'.repeat(43);

/** The relay the log was read from, as a store keeps its instance. */
export const RELAY_INSTANCE = 'relay-1';

/** A fabricated record of `proposal`: everyone eligible scored it 0, closing it at `closedAt`. */
function invented(proposal: string, closedAt: number): ResultBody {
  return {
    proposal,
    closedAt,
    eligible: 2,
    versions: [{ id: proposal, counts: [2, 0, 0, 0, 0] }],
    outcome: { kind: 'fail' },
    commit: INVENTED_COMMIT,
  };
}

/** The first Proposal of a folded state. */
function firstProposal(proposals: readonly Proposal[]): Proposal {
  const [first] = proposals;
  if (first === undefined) throw new Error('Expected a Proposal.');
  return first;
}

/**
 * Ana's group of Ana, Ben and Cal, a Member, where `forger` posts a
 * `forgery` of the result of Ana's Proposal, which Ana and Ben then decide
 * and Ana records.
 */
export function forgedLog(forger: Forger = 'cal', forgery: Forgery = 'invented'): ForgedLog {
  const log = groupLog({ members: ['Ben', 'Cal'], levels: { Cal: MEMBER } });
  const opened = log.minute;
  const proposal = log.propose('ana');
  const forge = (body: ResultBody): Posted => {
    const id = log.result(forger, body);
    return { id, record: log.records.at(-1) ?? never() };
  };
  log.minute += 1;
  const early =
    forgery === 'mismatched'
      ? null
      : forge(
          forgery === 'invented'
            ? invented(proposal, opened)
            : resultFor(firstProposal(log.state().proposals)),
        );
  log.minute += 1;
  log.vote('ana', proposal, 4);
  log.vote('ben', proposal, 3);
  const closedAt = log.minute;
  log.minute += 1;
  const forged = early ?? forge(invented(proposal, closedAt));
  log.minute += 1;
  const id = log.result('ana', resultFor(firstProposal(log.state().proposals)));
  const genuine = { id, record: log.records.at(-1) ?? never() };
  const records = [...log.records];
  return { group: log.group, records, proposal, closedAt, forged, forgery, genuine };
}

/** What a device's copy of a log was read at: the relay's minute, and the device's clock then. */
export interface ReadAt {
  readonly relayNow: number;
  readonly lastSyncAt: number;
}

/**
 * Keeps `forged`'s whole log on `store`, as `name`'s device in the group,
 * read in one pull from {@link RELAY_INSTANCE} as `at` says.
 */
export async function keepLog(
  store: Pick<Store, 'addGroup' | 'applyPull'>,
  forged: ForgedLog,
  name: string,
  at: ReadAt,
): Promise<void> {
  const { secretKey, author } = testKeys(name);
  await store.addGroup({
    groupId: forged.group,
    secret: new Uint8Array(32).fill(5),
    signingKey: secretKey,
    me: { author, name },
  });
  const cursor = forged.records.at(-1)?.seq ?? 0;
  const pull = { records: [...forged.records], cursor, instance: RELAY_INSTANCE, ...at };
  await store.applyPull(forged.group, pull, eventIdOf);
}

function never(): never {
  throw new Error('Expected a record.');
}
