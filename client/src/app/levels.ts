/**
 * Level labels for the screens. The engine names levels by id (`LEVELS`); the
 * messages module holds their names and descriptions as arrays in that order,
 * so no screen spells out a level id (ADR-0003).
 */
import { type Level, LEVELS } from '../engine/capabilities';
import { messages } from './messages';

/** A level's name, such as "Co-Creator". */
export function levelName(level: Level): string {
  return messages.levels.names[LEVELS.indexOf(level)] ?? '';
}

/** What a level adds over the one before it, in one line. */
export function levelDescription(level: Level): string {
  return messages.levels.descriptions[LEVELS.indexOf(level)] ?? '';
}
