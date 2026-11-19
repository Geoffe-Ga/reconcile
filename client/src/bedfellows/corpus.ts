/**
 * The Bedfellows corpus (#474; ADR-0080 §8): invented readers, shelf entries
 * and labelled reader–entry pairs that every threshold in #473 is measured
 * against. `corpus/README.md` says how pairs are labelled. Everything in it
 * is made up for this purpose: it names no real group, person or place.
 *
 * The corpus is split by reader and entry into `tune`, which thresholds are
 * set on, and `held-out`, which they're judged on and never tuned on. No
 * text sits in both.
 */
/** Where a reader, entry or publisher sits: thresholds are tuned on one and judged on the other. */
export type Split = 'tune' | 'held-out';

/** The kinds of labelled pair (`corpus/README.md`). */
export const PAIR_KINDS = [
  'shared-claim',
  'opposed',
  'unclear',
  'word-sense-trap',
  'idiom',
  'passing-mention',
  'near-copy',
  'unrelated',
] as const;

/** One kind of labelled pair. */
export type PairKind = (typeof PAIR_KINDS)[number];

/** One of a reader's own Documents. */
export interface ReaderDocument {
  readonly title: string;
  readonly text: string;
}

/** An invented reader: their community, and the Documents Bedfellows would read on their device. */
export interface Reader {
  readonly id: string;
  readonly split: Split;
  readonly community: string;
  readonly documents: readonly ReaderDocument[];
}

/** An invented shelf entry: a published Dispatch, its publisher, subject, and whether it's mainly hostile. */
export interface Entry {
  readonly id: string;
  readonly split: Split;
  readonly title: string;
  readonly text: string;
  /** Whether it is mainly hostility toward a group of people (#481 reads it). */
  readonly hostile: boolean;
  /** Anger at the powerful that isn't hostility toward a group of people (#481's control). */
  readonly angerAtPowerful?: boolean;
  readonly publisher: string;
  readonly subject: string;
}

/** An invented publishing group. */
export interface Publisher {
  readonly id: string;
  readonly name: string;
  readonly split: Split;
}

/** A labelled reader–entry pair, naming the sentence on each side where the kind has one. */
export interface Pair {
  readonly id: string;
  readonly reader: string;
  readonly entry: string;
  readonly kind: PairKind;
  readonly readerSentence?: string;
  readonly entrySentence?: string;
  /** A named case, such as #428's four failures (`corpus/README.md`). */
  readonly case?: string;
  readonly note?: string;
}

/** The whole corpus. */
export interface Corpus {
  readonly readers: readonly Reader[];
  readonly entries: readonly Entry[];
  readonly publishers: readonly Publisher[];
  readonly pairs: readonly Pair[];
}

/** `corpus/<name>.json`, which Vite bundles; it fails loudly when the file is missing. */
function file<T>(files: Record<string, T>, name: string): T {
  const found = files[`./corpus/${name}.json`];
  if (found === undefined) throw new Error(`bedfellows/corpus/${name}.json is missing.`);
  return found;
}

const FILES = import.meta.glob<unknown>('./corpus/*.json', { import: 'default', eager: true });

let loaded: Corpus | null = null;

/** The corpus as the repository holds it, read once. */
export function loadCorpus(): Corpus {
  loaded ??= {
    readers: file(FILES, 'readers') as readonly Reader[],
    entries: file(FILES, 'entries') as readonly Entry[],
    publishers: file(FILES, 'publishers') as readonly Publisher[],
    pairs: file(FILES, 'pairs') as readonly Pair[],
  };
  return loaded;
}
