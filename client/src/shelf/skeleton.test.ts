/**
 * A listed name's skeleton (#487; docs/spec/listed-doors.md §4.4): the
 * vendored confusables table, pinned by its hash; the golden vectors in
 * `vectors/skeleton.json`; and properties for case, spacing and settling.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sha256 } from '../crypto/hash';
import { CONFUSABLES, CONFUSABLES_VERSION } from './confusables';
import { nameSkeleton } from './skeleton';

/**
 * The SHA-256 of the table's lines joined by newlines, as
 * `scripts/confusables.mjs` writes them from Unicode 18.0.0's file, as bytes
 * like every pinned hash here. A table edited by hand, or written from
 * another file, fails here.
 */
const TABLE_SHA256 = [
  170, 122, 23, 176, 114, 153, 51, 10, 226, 214, 253, 95, 225, 113, 170, 129, 64, 30, 185, 65, 154,
  252, 253, 28, 219, 95, 84, 52, 71, 55, 204, 130,
];

/** `vectors/skeleton.json`. */
interface SkeletonFile {
  readonly kind: 'skeleton';
  readonly unicode: string;
  readonly same: readonly {
    readonly about: string;
    readonly names: readonly string[];
    readonly skeleton: string;
  }[];
  readonly apart: readonly { readonly about: string; readonly names: readonly string[] }[];
}

const [file] = Object.values(
  import.meta.glob<SkeletonFile>('./vectors/skeleton.json', { import: 'default', eager: true }),
);
if (file === undefined) throw new Error('vectors/skeleton.json is missing.');

/** Each source code point in the table, decoded as `skeleton.ts` reads it. */
function sources(): number[] {
  let source = 0;
  return CONFUSABLES.join(' ')
    .split(' ')
    .map((entry) => (source += parseInt(entry.split(':')[0] ?? '', 36)));
}

describe('the confusables table', () => {
  it('is the one the script writes from Unicode 18.0.0’s file', () => {
    const hash = sha256(new TextEncoder().encode(CONFUSABLES.join('\n')));
    expect([...hash]).toEqual(TABLE_SHA256);
    expect(CONFUSABLES_VERSION).toBe('18.0.0');
    expect(file.unicode).toBe(CONFUSABLES_VERSION);
  });

  it('holds every mapping in that file, each source once and in order', () => {
    const points = sources();
    expect(points).toHaveLength(6712);
    expect(new Set(points).size).toBe(points.length);
    expect(points).toEqual([...points].sort((a, b) => a - b));
  });

  it('settles every source, in either case, so a skeleton’s skeleton is itself', () => {
    const unsettled = sources()
      .map((point) => String.fromCodePoint(point))
      .flatMap((char) => [char, char.toUpperCase(), `a${char}${char}b`])
      .filter((name) => nameSkeleton(nameSkeleton(name)) !== nameSkeleton(name));
    expect(unsettled).toEqual([]);
  });
});

describe('nameSkeleton', () => {
  it.each(['EASTSIDE TENANTS UNI0N', 'Eastside  Tenants-Union', 'Еastside Tenants Union'])(
    'gives %s the skeleton of Eastside Tenants Union',
    (name) => {
      expect(nameSkeleton(name)).toBe(nameSkeleton('Eastside Tenants Union'));
    },
  );

  it.each(file.same.map((group) => [group.about, group] as const))(
    'gives one skeleton to names that differ by %s',
    (_, { names, skeleton }) => {
      expect(names.map(nameSkeleton)).toEqual(names.map(() => skeleton));
    },
  );

  it.each(file.apart.map((group) => [group.about, group.names] as const))(
    'tells apart names that differ by %s',
    (_, names) => {
      expect(new Set(names.map(nameSkeleton)).size).toBe(names.length);
    },
  );

  it.each([
    ['a zero-width space', 'Oak​St​Tenants'],
    ['a no-break space', 'Oak St Tenants'],
    ['a zero-width joiner', 'Oak St Ten‍ants'],
    ['a soft hyphen', 'Oak St Ten­ants'],
    ['an ideographic space', 'Oak　St Tenants'],
  ])('drops %s', (_, name) => {
    expect(nameSkeleton(name)).toBe('oaksttenants');
  });

  it('makes nothing of a name that is only spacing and punctuation', () => {
    expect(nameSkeleton(' -.!​ ')).toBe('');
  });

  it('gives a name in upper case the skeleton of the same name in lower case (fast-check)', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz0123456789 -.,’äéößσςдеж'.split('');
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...letters), maxLength: 40 }), (name) => {
        expect(nameSkeleton(name.toUpperCase())).toBe(nameSkeleton(name.toLowerCase()));
      }),
    );
  });

  it('ignores spacing and punctuation put between any two characters (fast-check)', () => {
    const gaps = fc.constantFrom(' ', '  ', '-', '.', ' ', '​', '/', '!');
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 12 }),
        gaps,
        fc.string({ unit: 'grapheme', maxLength: 12 }),
        (before, gap, after) => {
          expect(nameSkeleton(`${before}${gap}${after}`)).toBe(nameSkeleton(before + after));
        },
      ),
    );
  });

  it('settles: a skeleton’s skeleton is itself (fast-check)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (name) => {
        expect(nameSkeleton(nameSkeleton(name))).toBe(nameSkeleton(name));
      }),
    );
  });
});
