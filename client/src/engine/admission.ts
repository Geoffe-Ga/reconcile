/**
 * Earned voting rights (docs/spec/phase-1-spec.md §4; ADR-0014, ADR-0021,
 * ADR-0049, ADR-0075 §3; #101).
 *
 * Anyone with a live invite link can join and read, but a newcomer earns a
 * vote: `vouches` (2) members holding voting rights vouch for them, and
 * `waitDays` (14) pass from their join, both in relay time, never an
 * author's `ts` (ADR-0073). Until then `can()` gives them a Member's
 * capabilities, whatever level they chose. A new group still starts at once:
 * while fewer than `stewards.firstElectionAt` (3) people have held rights,
 * counting the founder, a join holds rights from its receipt. That count is
 * of people, not voting levels, so joiners who pick Member still use it up,
 * and it never reopens when someone leaves or steps down (ADR-0049: the
 * bootstrap ends when the first steward election opens).
 *
 * The fold records when each member's rights arrive as their `rightsAt`, and
 * the screens ask the same functions here, so a screen never offers a vouch
 * the fold would ignore. Vouches show who knows whom, so they live only in
 * the group's sealed log, where every member reads them, like ballots
 * (ADR-0010).
 */
import { can, holdsRights, type Roster } from './capabilities';
import { DAY_MINUTES, type Rules } from './rules';

/**
 * A valid vouch, as the fold keeps it: its event id, seq and receipt minute,
 * who vouched (`by`), and the member they vouched for. One from someone who later
 * leaves still counts. Withdrawing one stays deferred (ADR-0052).
 */
export interface Vouch {
  readonly id: string;
  readonly seq: number;
  readonly received: number;
  readonly by: string;
  readonly member: string;
}

/** What admission reads of a person: when the relay received their join, and when their rights arrive. */
export interface Admitted {
  readonly author: string;
  readonly received: number;
  readonly rightsAt: number | null;
}

/** What admission reads of a group: its rules, its members and former members, and its vouches. */
export interface AdmissionState extends Roster {
  readonly rules: Rules;
  readonly members: readonly (Roster['members'][number] & Admitted)[];
  readonly former: readonly Admitted[];
  readonly vouches: readonly Vouch[];
}

/** When the wait of someone whose join the relay received at `received` ends: `waitDays` × 1,440 later. */
export function waitEnd(rules: Rules, received: number): number {
  return received + rules.waitDays * DAY_MINUTES;
}

/**
 * When a newcomer whose join the relay received at `received` earns voting
 * rights, given the valid vouches for them in relay order: the later of
 * their wait's end and the receipt of the vouch that makes `vouches`, or
 * null while they have fewer.
 */
export function earnedAt(rules: Rules, received: number, vouches: readonly Vouch[]): number | null {
  const last = vouches[rules.vouches - 1];
  return last === undefined ? null : Math.max(waitEnd(rules, received), last.received);
}

/** When `person`'s voting rights arrive, in relay minutes, whether they're in the group or have left; null if never. */
export function rightsAt(
  state: Pick<AdmissionState, 'members' | 'former'>,
  person: string,
): number | null {
  const found = [...state.members, ...state.former].find((m) => m.author === person);
  return found?.rightsAt ?? null;
}

/** The valid vouches for `person`, in relay order. */
export function vouchesFor(state: Pick<AdmissionState, 'vouches'>, person: string): Vouch[] {
  return state.vouches.filter((v) => v.member === person);
}

/**
 * Whether `author` may vouch for `person` now: they hold `vouch` (a voting
 * level, with rights, not suspended), `person` is another current member, and
 * `author` hasn't vouched for them before.
 */
export function mayVouch(state: AdmissionState, author: string, person: string): boolean {
  return (
    can(state, author, 'vouch') &&
    person !== author &&
    state.members.some((m) => m.author === person) &&
    !state.vouches.some((v) => v.by === author && v.member === person)
  );
}

/**
 * Whether a join received now holds rights at once (ADR-0014, ADR-0049):
 * while fewer than `stewards.firstElectionAt` people, members or former,
 * have held rights by `state.at`. Everyone counts whatever level they chose,
 * so joiners who pick Member can't keep it open and then step up unvouched.
 */
export function bootstrapOpen(state: AdmissionState): boolean {
  const held = [...state.members, ...state.former].filter(
    (m) => m.rightsAt !== null && m.rightsAt <= state.at,
  );
  return held.length < state.rules.stewards.firstElectionAt;
}

/**
 * A newcomer's way to a vote, for the screens: who has vouched for them (in
 * relay order), how many vouches they need, when their wait ends, and when
 * their rights arrive once they have the vouches (null before).
 */
export interface Admission {
  readonly vouchedBy: readonly string[];
  readonly needed: number;
  readonly waitEnd: number;
  readonly rightsAt: number | null;
}

/** `person`'s way to a vote while they're a member without rights at `state.at`, else null. */
export function admissionOf(state: AdmissionState, person: string): Admission | null {
  const member = state.members.find((m) => m.author === person);
  if (member === undefined || holdsRights(state, person)) return null;
  return {
    vouchedBy: vouchesFor(state, person).map((v) => v.by),
    needed: state.rules.vouches,
    waitEnd: waitEnd(state.rules, member.received),
    rightsAt: member.rightsAt,
  };
}

/**
 * Whether to offer `me` Vouch for `person`: they may vouch for them now, and
 * `person` is a newcomer still short of vouches. A vouch beyond the ones
 * needed changes nothing, so the screens don't ask for one.
 */
export function vouchWanted(state: AdmissionState, me: string, person: string): boolean {
  const admission = admissionOf(state, person);
  return (
    admission !== null &&
    admission.vouchedBy.length < admission.needed &&
    mayVouch(state, me, person)
  );
}
