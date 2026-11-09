/**
 * The key the store dedupes its log by: an event's id (spec §4 and §7).
 *
 * Kept in one place so that #69, whose records put a key and signature
 * before the event bytes, changes only this function.
 */

import { parseEvent } from '../engine/event';
import type { EventIdOf } from './db';

/** The id of the event in `bytes`, or `null` when they don't hold an event. */
export const eventIdOf: EventIdOf = (bytes) => parseEvent(bytes)?.id ?? null;
