// Test-only: name-derived, deterministic seats and secrets. Never mirror them in production code.
/**
 * Coalition logs for tests (#100), built through the engine: events signed
 * with the fixed test keys and folded with `fold`, never hand-written state.
 * Seqs are global across logs, as the relay's one counter is, and an event's
 * `ts` never depends on where it lands, so the same event signs to the same
 * record whatever order a test puts it in.
 */
import { base64url, fromBase64url } from '../crypto/base64url';
import { sha256 } from '../crypto/hash';
import { sealSeatSecrets } from '../crypto/innerSeal';
import { seatKeyOf, signSeatProof } from '../crypto/seat';
import { foldTogether, motionsFor, seatIn } from '../engine/crossing';
import type { EventDraft, GroupResultValue } from '../engine/event';
import { fold, type GroupState, type LogRecord } from '../engine/fold';
import { authorOf, signedAs } from './keys';

const encoder = new TextEncoder();

/** The 32-byte seat secret of the test seat `name`, from SHA-256("reconcile/test-seat/" + name). */
export function seatSecret(name: string): Uint8Array {
  return sha256(encoder.encode(`reconcile/test-seat/${name}`));
}

/** The base64url public seat key of the test seat `name`. */
export function seatKey(name: string): string {
  return base64url(seatKeyOf(seatSecret(name)));
}

/** 32 bytes in base64url for a coalition secret or `inner`, from SHA-256("reconcile/test-secret/" + name). */
export function testSecret(name: string): string {
  return base64url(sha256(encoder.encode(`reconcile/test-secret/${name}`)));
}

/** An event before the log stamps its group and time. */
type Unstamped<E = EventDraft> = E extends EventDraft ? Omit<E, 'group' | 'ts'> : never;

/** A folded log: its state, and for a member group the seat it holds in the coalition. */
export interface FoldedLog {
  readonly state: GroupState;
  readonly seat: string | null;
}

/**
 * Folds logs as a device would: the coalition's first, then each other log,
 * a member group's, with the motions its seat decides and, by log, the
 * Proposals whose ballots that group's device has cleared (#111).
 */
export function foldLogs(
  logs: Readonly<Record<string, readonly LogRecord[]>>,
  relayNow: number | null,
  cleared: Readonly<Record<string, readonly string[]>> = {},
): Record<string, FoldedLog> {
  const coalition = fold(logs.coalition ?? [], relayNow);
  const folded: Record<string, FoldedLog> = { coalition: { state: coalition, seat: null } };
  for (const [log, records] of Object.entries(logs)) {
    if (log === 'coalition') continue;
    const gone = cleared[log] ?? [];
    const seat = seatIn(fold(records, relayNow, [], gone), coalition);
    const outside = seat === null ? [] : motionsFor(coalition, seat);
    folded[log] = { state: fold(records, relayNow, outside, gone), seat };
  }
  return folded;
}

/** The folded log named `log`, failing the test when there is none. */
export function folded(logs: Readonly<Record<string, FoldedLog>>, log: string): FoldedLog {
  const found = logs[log];
  if (found === undefined) throw new Error(`no log is named "${log}"`);
  return found;
}

/** The seat the folded group `log` holds, failing the test when it holds none. */
export function seatOf(logs: Readonly<Record<string, FoldedLog>>, log: string): string {
  const { seat } = folded(logs, log);
  if (seat === null) throw new Error(`the log "${log}" holds no seat in the coalition`);
  return seat;
}

/** A coalition's log and its member groups' logs, one relay seq across them all. */
export class Logs {
  readonly logs: Record<string, LogRecord[]> = {};
  /** Each log's genesis id, once it has one. */
  readonly ids: Record<string, string> = {};
  private seq = 0;

  /** Appends `input`, signed by `signer`'s test key, to `log` at relay minute `received`. */
  add(log: string, received: number, signer: string, input: Unstamped): string {
    const group = input.type === 'genesis' ? '' : (this.ids[log] ?? '');
    const draft = { ...input, group, ts: 0 } as EventDraft;
    const { record, id } = signedAs(signer, draft);
    this.seq += 1;
    (this.logs[log] ??= []).push({ seq: this.seq, received, bytes: record });
    if (input.type === 'genesis') this.ids[log] ??= id;
    return id;
  }

  /** A group founded by `members[0]`, the others joining: the first three hold voting rights at once. */
  group(log: string, received: number, members: readonly string[], name = 'Riverside'): string {
    const [founder = 'ana', ...joiners] = members;
    const body = { name, founder, title: 'House rules', atoms: ['Quiet after 11pm.'] };
    const id = this.add(log, received, founder, { type: 'genesis', body });
    joiners.forEach((joiner, i) => {
      this.add(log, received + 1 + i, joiner, { type: 'join', body: { name: joiner } });
    });
    return id;
  }

  /** `proposer`'s reconcile Proposal in `log`, for the seat `seat`, with `title` and `why` the group reads. */
  reconcile(
    log: string,
    received: number,
    proposer: string,
    seat: string,
    { title = 'Reconcile', why = 'We share a river.' } = {},
  ): string {
    const target = {
      kind: 'reconcile',
      secret: testSecret('coalition'),
      inner: testSecret('inner'),
      seat: base64url(seatSecret(seat)),
      ...COALITION_STATEMENT,
    } as const;
    return this.add(log, received, proposer, { type: 'proposal', body: { target, title, why } });
  }

  /** `voter`'s ballot in `log` scoring `proposal`'s one version, with `note`. */
  vote(
    log: string,
    received: number,
    voter: string,
    proposal: string,
    score: 0 | 1 | 2 | 3 | 4,
    note?: string,
  ) {
    const body = {
      proposal,
      scores: { [proposal]: score },
      ...(note === undefined ? {} : { note }),
    };
    return this.add(log, received, voter, { type: 'vote', body });
  }

  /** A coalition genesis by `author`, which isn't a participant, naming `seats`. */
  coalition(received: number, seats: readonly string[], author = 'kim'): string {
    const body = {
      kind: 'coalition',
      ...COALITION_STATEMENT,
      seats: seats.map((seat) => ({ name: seat, key: seatKey(seat) })),
    } as const;
    return this.add('coalition', received, author, { type: 'genesis', body });
  }

  /** `who` joins the coalition under `seat`, with that seat's proof for their key. */
  join(received: number, who: string, seat: string): string {
    const coalition = this.ids.coalition ?? '';
    const joiner = fromBase64url(authorOf(who));
    const proof = base64url(signSeatProof(seatSecret(seat), coalition, joiner));
    const body = { name: who, seat: seatKey(seat), proof };
    return this.add('coalition', received, who, { type: 'join', body });
  }

  /** `who` posts `result` for `seat` on `motion` (the genesis id for the reconcile result). */
  result(received: number, who: string, motion: string, seat: string, result: GroupResultValue) {
    const body = { motion, seat: seatKey(seat), result };
    return this.add('coalition', received, who, { type: 'group-result', body });
  }

  /** `who`, from the group whose seat is `seat`, proposes admitting it as `name` (#114). */
  admit(received: number, who: string, seat: string, name: string): string {
    const coalition = this.ids.coalition ?? '';
    const proof = base64url(
      signSeatProof(seatSecret(seat), coalition, fromBase64url(authorOf(who))),
    );
    const target = { kind: 'admit', seat: { name, key: seatKey(seat) }, proof } as const;
    const body = { target, title: `Admit ${name}`, why: 'They share the river.' };
    return this.add('coalition', received, who, { type: 'proposal', body });
  }

  /** `who`'s motion in the coalition: new text for its first Atom. */
  motion(received: number, who: string, text = 'We keep the river and its banks clean.'): string {
    const atom = `${this.ids.coalition ?? ''}.0`;
    const body = { atom, title: 'Banks too', why: 'The banks matter.', text };
    return this.add('coalition', received, who, { type: 'proposal', body });
  }

  /**
   * A formed coalition of `seats` from relay minute `received`: its genesis,
   * then `participants[i]` joining under `seats[i]` and passing the genesis.
   */
  formed(received: number, seats: readonly string[], participants: readonly string[]): number {
    this.coalition(received, seats);
    let at = received + 1;
    seats.forEach((seat, i) => this.join((at += 1), participants[i] ?? '', seat));
    const genesis = this.ids.coalition ?? '';
    seats.forEach((seat, i) =>
      this.result((at += 1), participants[i] ?? '', genesis, seat, 'pass'),
    );
    return at + 1;
  }
}

/** The coalition's proposed name and statement, in every reconcile target and genesis these build. */
export const COALITION_STATEMENT = {
  name: 'Rivers United',
  title: 'Shared ground',
  atoms: ['We keep the river clean.'],
} as const;

/** A coalition's name and statement, as a genesis and the reconcile targets into it carry them. */
export interface Statement {
  readonly name: string;
  readonly title: string;
  readonly atoms: readonly string[];
}

/** One seat a nested genesis names: the test seat's name, and the level it states, if any (#122). */
export type NestedSeat = readonly [seat: string, level?: number];

/**
 * Logs with coalitions in coalitions (#122): each coalition is a log of its
 * own, by name, where {@link Logs} has one called "coalition". A coalition
 * `X`'s secret is `testSecret(X)`, its inner `testSecret("inner" + X)`, and
 * the seat it holds above is the test seat `X`.
 */
export class NestedLogs extends Logs {
  /** A coalition genesis in `log` naming `seats`, by `author`, with `statement`. */
  coalitionIn(
    log: string,
    received: number,
    seats: readonly NestedSeat[],
    statement: Statement = COALITION_STATEMENT,
    author = 'kim',
  ): string {
    const body = {
      kind: 'coalition',
      ...statement,
      seats: seats.map(([seat, level]) => ({
        name: seat,
        key: seatKey(seat),
        ...(level === undefined ? {} : { level }),
      })),
    } as const;
    return this.add(log, received, author, { type: 'genesis', body });
  }

  /** `who` joins the coalition `log` under `seat`, with that seat's proof for their key. */
  joinIn(log: string, received: number, who: string, seat: string): string {
    const id = this.ids[log] ?? '';
    const proof = base64url(signSeatProof(seatSecret(seat), id, fromBase64url(authorOf(who))));
    const body = { name: who, seat: seatKey(seat), proof };
    return this.add(log, received, who, { type: 'join', body });
  }

  /** `who` posts `result` for `seat` on `motion` in the coalition `log`. */
  resultIn(
    log: string,
    received: number,
    who: string,
    motion: string,
    seat: string,
    result: GroupResultValue,
  ): string {
    const body = { motion, seat: seatKey(seat), result };
    return this.add(log, received, who, { type: 'group-result', body });
  }

  /** `who`'s motion in the coalition `log`: new text for its first Atom. */
  motionIn(log: string, received: number, who: string, text: string): string {
    const body = {
      atom: `${this.ids[log] ?? ''}.0`,
      title: 'Say it better',
      why: 'Clearer.',
      text,
    };
    return this.add(log, received, who, { type: 'proposal', body });
  }

  /** A formed coalition `log` of `seats`, `participants[i]` joining under seat i and passing. */
  formedIn(
    log: string,
    received: number,
    seats: readonly NestedSeat[],
    participants: readonly string[],
    statement: Statement = COALITION_STATEMENT,
  ): number {
    this.coalitionIn(log, received, seats, statement);
    seats.forEach(([seat], i) => this.joinIn(log, received + 1, participants[i] ?? '', seat));
    const genesis = this.ids[log] ?? '';
    seats.forEach(([seat], i) =>
      this.resultIn(log, received + 2, participants[i] ?? '', genesis, seat, 'pass'),
    );
    return received + 3;
  }

  /** Group `log`'s plain reconcile Proposal into the coalition `into`, for seat `seat`. */
  reconcileInto(
    log: string,
    received: number,
    who: string,
    into: string,
    seat: string,
    statement: Statement,
  ): string {
    const target = {
      kind: 'reconcile',
      secret: testSecret(into),
      inner: testSecret(`inner${into}`),
      seat: base64url(seatSecret(seat)),
      ...statement,
    } as const;
    const body = { target, title: `Reconcile into ${statement.name}`, why: 'Neighbours.' };
    return this.add(log, received, who, { type: 'proposal', body });
  }

  /** Coalition `log`'s sealed reconcile motion into the coalition `into`, under its seat `log`. */
  sealedInto(log: string, received: number, who: string, into: string, statement: Statement) {
    const sealed = sealSeatSecrets(this.ids[log] ?? '', fromBase64url(testSecret(`inner${log}`)), {
      secret: fromBase64url(testSecret(into)),
      inner: fromBase64url(testSecret(`inner${into}`)),
      seat: seatSecret(log),
    });
    const target = { kind: 'reconcile', sealed, key: seatKey(log), ...statement } as const;
    const body = { target, title: `Reconcile into ${statement.name}`, why: 'Neighbours.' };
    return this.add(log, received, who, { type: 'proposal', body });
  }

  /** Every log folded together, as a device holding them all folds them, by name. */
  foldAll(relayNow: number | null): Record<string, GroupState> {
    const names = Object.keys(this.logs);
    const states = foldTogether(
      names.map((name) => ({ records: this.logs[name] ?? [], relayNow })),
    );
    return Object.fromEntries(names.map((name, i) => [name, states[i] ?? fold([], relayNow)]));
  }
}
