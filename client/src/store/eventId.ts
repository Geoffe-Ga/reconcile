/**
 * The key the store dedupes its log by: the id of the event a signed record
 * carries (spec §3, §4 and §7).
 *
 * A record must verify, and its event's `author` must be the key that signed
 * it, before it has an id at all: the fold's own rule, so the log never keeps
 * a forged copy in place of the real one.
 */

import { parseRecord } from '../engine/event';
import type { EventIdOf } from './db';

/** The id of the event in the signed record `bytes`, or `null` when they don't hold one. */
export const eventIdOf: EventIdOf = (bytes) => parseRecord(bytes)?.id ?? null;
