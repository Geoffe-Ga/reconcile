/**
 * A listed name's skeleton (#487; ADR-0081; docs/spec/listed-doors.md §4.4):
 * the name reduced so that names that look alike compare equal, so a
 * look-alike never shows beside the listing that had the name first
 * (`fold.ts`, rule 4).
 *
 * Every device computes it the same way, from the name alone:
 *
 * 1. NFKC, so compatibility forms (full-width letters, ligatures, circled
 *    digits) become the characters they stand for;
 * 2. case folding, as upper case then lower case with one sigma, so `ß` and
 *    `ss`, `ς` and `σ` compare equal as well as `A` and `a`, wherever a word
 *    ends;
 * 3. removal of whitespace, punctuation and default-ignorable code points
 *    (zero-width spaces and joiners among them);
 * 4. Unicode's confusables mapping (UTS #39's skeleton: NFD, each code point
 *    to its prototype, NFD again), from `confusables.ts`, pinned to one
 *    Unicode version;
 * 5. steps 1 to 4 again until nothing changes, since a prototype may be in
 *    the other case (`0`'s is `O`), punctuation or a compatibility form
 *    (`⏨`'s is `₁₀`), and what step 1 or 2 makes of it may have a prototype
 *    of its own (Old Italic `𐌑` maps to `M`, whose lower case `m` maps to
 *    `rn`). Every name settles within {@link PASSES} passes.
 *
 * So "Eastside Tenants Union", "EASTSIDE TENANTS UNI0N", "Eastside
 * Tenants-Union" and one with a Cyrillic `Е` share a skeleton. It applies to
 * listed names only: names inside a group keep their key suffixes, and
 * look-alike detection there stays deferred (ADR-0045).
 *
 * NFKC, case and the character classes come from the device's JavaScript
 * engine. Unicode keeps each stable once a character is assigned, so two
 * devices can differ only on a name with a character newer than one
 * engine's Unicode version: that device ignores the listing (rule 3) until
 * it updates. The skeleton is a public name's, computed on the device, and
 * the relay stores it without reading it.
 */
import { CONFUSABLES } from './confusables';

/** Whitespace, punctuation and default-ignorable code points: what a skeleton drops. */
const DROPPED = /[\p{White_Space}\p{P}\p{Default_Ignorable_Code_Point}]/gu;

/** The confusables table as source code point to prototype, built on first use. */
let table: Map<number, string> | null = null;

/** {@link CONFUSABLES} as a map, read once. */
function prototypes(): Map<number, string> {
  if (table !== null) return table;
  const map = new Map<number, string>();
  let source = 0;
  for (const entry of CONFUSABLES.join(' ').split(' ')) {
    const [step = '', target = ''] = entry.split(':');
    source += parseInt(step, 36);
    const points = target.split('.').map((point) => parseInt(point, 36));
    map.set(source, String.fromCodePoint(...points));
  }
  table = map;
  return map;
}

/** Steps 1 to 3: `text` in NFKC, case folded, with whitespace, punctuation and ignorables gone. */
function folded(text: string): string {
  const lower = text.normalize('NFKC').toUpperCase().toLowerCase();
  // Lower case writes a final sigma at a word's end; case folding has one sigma.
  return lower.replaceAll('ς', 'σ').replace(DROPPED, '');
}

/** UTS #39's skeleton of `text`: NFD, each code point to its prototype, NFD again. */
function mapped(text: string): string {
  const map = prototypes();
  let out = '';
  for (const char of text.normalize('NFD')) out += map.get(char.codePointAt(0) ?? 0) ?? char;
  return out.normalize('NFD');
}

/** The most passes of step 4 a skeleton takes: every name settles sooner. */
export const PASSES = 3;

/** `name`'s skeleton: equal for names that look alike (§4.4). */
export function nameSkeleton(name: string): string {
  let skeleton = folded(name);
  for (let pass = 0; pass < PASSES; pass += 1) {
    const next = folded(mapped(skeleton));
    if (next === skeleton) break;
    skeleton = next;
  }
  return skeleton;
}
