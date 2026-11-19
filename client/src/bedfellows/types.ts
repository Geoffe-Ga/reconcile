/**
 * The shapes of the Bedfellows pipeline (#475; ADR-0080 §1, §3, §4, §7): what
 * goes in, what comes out, and the ports each model sits behind. Every model
 * the pipeline uses is a port, so each later issue in #473 swaps one stand-in
 * for a real model and the pipeline never stops working.
 *
 * Nothing here is kept: the reader's text, its vectors and every score live
 * only in the page's and the worker's memory (ADR-0080 §5).
 */

/** One of the reader's own Documents, as the pipeline reads it. */
export interface BedfellowsDocument {
  readonly title: string;
  readonly text: string;
}

/** A public shelf entry: its title counts as one of its claims. */
export interface BedfellowsEntry {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

/** One run's input: the reader's Documents, the shelf, and the dial's position. */
export interface BedfellowsInput {
  readonly reader: readonly BedfellowsDocument[];
  readonly entries: readonly BedfellowsEntry[];
  /** The stretch dial (ADR-0080 §4). Accepted and not yet read: #479 reads it. */
  readonly dial: number;
}

/** A claim's vector. */
export type Vector = readonly number[];

/** Cuts a text into claims, one sentence each (ADR-0080 §1). */
export type Splitter = (text: string) => string[];

/** The sentence-embedding port: sentences in, one vector each out, in order. */
export interface Embedder {
  embed(sentences: readonly string[]): Promise<readonly Vector[]>;
}

/** What the stance check says of a pair of sentences (ADR-0080 §3). */
export type Stance = 'agrees' | 'opposes' | 'unsure';

/** The stance port: the reader's sentence and the entry's in, a stance out. */
export interface StanceJudge {
  judge(readerSentence: string, entrySentence: string): Promise<Stance>;
}

/** The models a run uses. Without a splitter, the stand-in splitter cuts claims. */
export interface Models {
  readonly embedder: Embedder;
  readonly judge: StanceJudge;
  readonly splitter?: Splitter;
}

/** How far an entry sits from the reader (ADR-0080 §4). */
export type Tier = 'close' | 'middle' | 'strange';

/**
 * Why an entry is shown: its matched sentence, quoted as written, and the
 * reader's own (shown only on a tap, ADR-0080 §7). `verified` says the stance
 * check agreed: "You both care about this:" rather than "You both write about this:".
 */
export interface Reason {
  readonly entrySentence: string;
  readonly readerSentence: string;
  readonly verified: boolean;
}

/** One entry Bedfellows would show, with its tier and its reason. */
export interface Row {
  readonly entryId: string;
  readonly tier: Tier;
  readonly reason: Reason;
}

/** The page asks the worker for one run's rows; `id` names the run in every later message. */
export interface RunRequest {
  readonly type: 'run';
  readonly id: number;
  readonly input: BedfellowsInput;
}

/** The page cancels run `id`: the worker stops it and answers nothing. */
export interface CancelRequest {
  readonly type: 'cancel';
  readonly id: number;
}

/** What the page sends the worker. */
export type ToWorker = RunRequest | CancelRequest;

/**
 * What the worker sends back: run `id`'s rows, or that it failed. A failure
 * carries no message, so no word of the reader's can reach one.
 */
export type FromWorker =
  | { readonly type: 'rows'; readonly id: number; readonly rows: readonly Row[] }
  | { readonly type: 'error'; readonly id: number };
