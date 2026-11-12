/**
 * A coalition's room (#125; ADR-0011, ADR-0009): one small, end-to-end
 * encrypted room per coalition, where people from all its member groups talk
 * in plain text under their coalition names.
 *
 * The room is a log of its own, apart from the coalition's: its mailboxes and
 * seal key derive from the coalition's `inner` (spec §3), which only seated
 * groups hold, so neither a coalition's followers (#124), nor a group asking
 * in before it's seated (#313), nor the relay can read it. A message is a signed record, `{v: 1, type: 'message',
 * group: coalitionId, author, ts, body: {text}}`, and {@link foldRoom} reads
 * the room's log against the coalition's folded state: a message shows only
 * from a participant bound to one of the coalition's seats, never from a key
 * that only holds the coalition secret, and only while it is at most 30 days
 * old by relay time. Nothing here reads a person's key in one log to find
 * them in another: a message names its author only as the coalition knows
 * them, by their coalition name.
 */
import { EVENT_VERSION, type GroupEvent, parseRecord } from './event';
import type { GroupState, LogRecord } from './fold';
import { displayName } from './names';
import { DAY_MINUTES } from './rules';
import { codePointLength } from './text';

/** How long a device keeps a message, in relay minutes: 30 days, 43,200. */
export const ROOM_KEEP_MINUTES = 30 * DAY_MINUTES;

/** The most code points a message holds, after NFC and trimming. */
export const MESSAGE_MAX = 2000;

/** A message the room shows: where the relay put it, who wrote it, and its text. */
export interface RoomMessage {
  /** The event's id. */
  readonly id: string;
  /** Its relay seq. */
  readonly seq: number;
  /** The relay minute it was received: the time the room shows. */
  readonly received: number;
  /** Its author's key in the coalition. */
  readonly author: string;
  /** Its author's coalition name, with a key suffix when another's matches (`displayName`). */
  readonly name: string;
  /** Its text, in NFC and trimmed, line breaks kept. */
  readonly text: string;
}

/**
 * `text` as a message holds it: in NFC and trimmed, or null when that leaves
 * fewer than 1 or more than {@link MESSAGE_MAX} code points.
 */
export function messageText(text: string): string | null {
  const shown = text.normalize('NFC').trim();
  const length = codePointLength(shown);
  return length >= 1 && length <= MESSAGE_MAX ? shown : null;
}

/** Why the composer can't send `text`: `empty`, `long`, or null when it can. */
export function checkMessage(text: string): 'empty' | 'long' | null {
  if (messageText(text) !== null) return null;
  return text.trim() === '' ? 'empty' : 'long';
}

/**
 * Whether a message received at relay minute `received` is still kept at
 * relay minute `relayNow`: at most {@link ROOM_KEEP_MINUTES} before it.
 */
export function keptInRoom(received: number, relayNow: number): boolean {
  return relayNow - received <= ROOM_KEEP_MINUTES;
}

/** The keys of the coalition's current participants, each bound to one of its seats. */
function participantsOf(coalition: Pick<GroupState, 'members' | 'coalition'>): Set<string> {
  const seats = new Set(coalition.coalition?.seats.map((seat) => seat.key));
  const bound = new Set(
    coalition.coalition?.bindings.filter((b) => seats.has(b.seat)).map((b) => b.author),
  );
  return new Set(coalition.members.map((m) => m.author).filter((author) => bound.has(author)));
}

/**
 * Whether `author` writes in the room: a current participant bound to one of
 * the coalition's seats, whose messages {@link foldRoom} shows.
 */
export function isParticipant(
  coalition: Pick<GroupState, 'members' | 'coalition'>,
  author: string,
): boolean {
  return participantsOf(coalition).has(author);
}

/** A message of this coalition, from one of `speakers`, with text that fits, or null. */
function messageIn(event: GroupEvent, coalitionId: string, speakers: Set<string>): string | null {
  if (event.type !== 'message' || event.v !== EVENT_VERSION) return null;
  if (event.group !== coalitionId || !speakers.has(event.author)) return null;
  return messageText(event.body.text);
}

/**
 * The messages the room's `records` show, in the order the log holds them,
 * which is relay order (`store/logOrder.ts`): each signed `message` for this
 * coalition, once, from a participant `coalition`'s state binds to one of its
 * seats, with text that fits, received at most 30 days of relay time before
 * `relayNow`. A participant who has left is no longer one, so none of theirs
 * show. Nothing shows before the coalition's genesis, or with no relay minute.
 */
export function foldRoom(
  records: readonly LogRecord[],
  coalition: GroupState,
  relayNow: number | null,
): RoomMessage[] {
  const coalitionId = coalition.group;
  if (coalitionId === null || coalition.coalition === null || relayNow === null) return [];
  const speakers = participantsOf(coalition);
  const seen = new Set<string>();
  return records.flatMap(({ seq, received, bytes }) => {
    if (!keptInRoom(received, relayNow)) return [];
    const parsed = parseRecord(bytes);
    const text = parsed === null ? null : messageIn(parsed.event, coalitionId, speakers);
    if (parsed === null || text === null || seen.has(parsed.id)) return [];
    seen.add(parsed.id);
    const { author } = parsed.event;
    const name = displayName(coalition, author) ?? '';
    return [{ id: parsed.id, seq, received, author, name, text }];
  });
}
