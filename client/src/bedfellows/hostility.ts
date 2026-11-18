/**
 * The shared-enemy check (#481; ADR-0080 §6): a claim that is mainly
 * hostility toward a group of people can't be an entry's reason, so a feed
 * that leads outward from one shared point never leads through a shared enemy.
 *
 * It asks a stance model one zero-shot question, {@link HOSTILITY_HYPOTHESIS},
 * with the claim as premise, so no third model is downloaded: a claim is
 * flagged when the model's entailment reaches `THRESHOLDS.hostility.entails`.
 * {@link hostilityReport} measures any check against the corpus's `hostile`
 * labels, and against its `angerAtPowerful` entries, which are anger at a
 * powerful body and must not be flagged.
 *
 * **It ships switched off** ({@link SHARED_ENEMY_CHECK}): measured on the
 * corpus with the three candidate stance models (#478), none tells hostility
 * toward people from other strong words well enough to help, and no stance
 * model ships to ask in any case (ADR-0080 §6's amendment). The pipeline
 * takes a check through `Models.hostility`; the worker hands it none.
 *
 * It sends nothing and keeps nothing: a sentence and its score live only in
 * memory for one run.
 */
import { type Corpus, type Entry, loadCorpus, type Split } from './corpus';
import type { StanceLabels } from './judge';
import type { PairClassifier } from './runtime';
import { claimsIn, splitClaims } from './split';
import { THRESHOLDS } from './thresholds';
import type { HostilityCheck } from './types';

/** The zero-shot question, the claim as premise and this as hypothesis (#481's wording). */
export const HOSTILITY_HYPOTHESIS = 'This is mainly hostility toward a group of people.';

/**
 * Whether the pipeline holds back claims the check flags. Off: on the
 * corpus no candidate model separates hostility toward people from anger at
 * the powerful (`thresholds.ts`, ADR-0080 §6), and none ships. Switching it
 * on needs a model that does, measured by {@link heldOutHostilityReport},
 * and the worker handing the pipeline {@link modelHostility} over it.
 */
export const SHARED_ENEMY_CHECK = false;

/**
 * The check over a started inference model whose entailment is
 * `labels.entailment`: a sentence is mainly hostile when the model's
 * entailment of {@link HOSTILITY_HYPOTHESIS} from it is at least `bar`.
 */
export function modelHostility(
  classifier: PairClassifier,
  labels: Pick<StanceLabels, 'entailment'>,
  bar: number = THRESHOLDS.hostility.entails,
): HostilityCheck {
  return {
    isMainlyHostile: async (sentence) => {
      const probabilities = await classifier.classify(sentence, HOSTILITY_HYPOTHESIS);
      return (probabilities[labels.entailment] ?? 0) >= bar;
    },
  };
}

/** How a check did on one kind of entry. */
export interface HostilityCounts {
  readonly entries: number;
  /** Entries with at least one claim flagged. */
  readonly flagged: number;
  readonly claims: number;
  readonly claimsFlagged: number;
}

/** How a check did on one split. */
export interface HostilityReport {
  readonly split: Split;
  /** Entries labelled `hostile`: flagged is caught. */
  readonly hostile: HostilityCounts;
  /** Every other entry: flagged is wrongly flagged. */
  readonly others: HostilityCounts;
  /** The others that are anger at the powerful, the control (`corpus/README.md`). */
  readonly angerAtPowerful: HostilityCounts;
  /** Wrongly flagged entries by subject, to see whether they lean toward one kind of group. */
  readonly othersFlaggedBySubject: Readonly<Record<string, number>>;
  /** The ids of wrongly flagged entries, in corpus order. */
  readonly flaggedOthers: readonly string[];
  /** The ids of hostile entries with no claim flagged, in corpus order. */
  readonly missedHostile: readonly string[];
}

/** One entry's claims and how many `check` flags. */
interface Checked {
  readonly entry: Entry;
  readonly claims: number;
  readonly flagged: number;
}

/** The counts over `checked`. */
function countsOf(checked: readonly Checked[]): HostilityCounts {
  return {
    entries: checked.length,
    flagged: checked.filter((c) => c.flagged > 0).length,
    claims: checked.reduce((sum, c) => sum + c.claims, 0),
    claimsFlagged: checked.reduce((sum, c) => sum + c.flagged, 0),
  };
}

/** `check`'s report on `split` of `corpus`, asking about one claim at a time. */
async function report(
  check: HostilityCheck,
  split: Split,
  corpus: Corpus,
): Promise<HostilityReport> {
  const checked: Checked[] = [];
  for (const entry of corpus.entries.filter((e) => e.split === split)) {
    const claims = claimsIn(entry.title, entry.text, splitClaims);
    let flagged = 0;
    for (const claim of claims) if (await check.isMainlyHostile(claim)) flagged += 1;
    checked.push({ entry, claims: claims.length, flagged });
  }
  const hostile = checked.filter((c) => c.entry.hostile);
  const others = checked.filter((c) => !c.entry.hostile);
  const wrong = others.filter((c) => c.flagged > 0);
  const bySubject: Record<string, number> = {};
  for (const { entry } of wrong) bySubject[entry.subject] = (bySubject[entry.subject] ?? 0) + 1;
  return {
    split,
    hostile: countsOf(hostile),
    others: countsOf(others),
    angerAtPowerful: countsOf(others.filter((c) => c.entry.angerAtPowerful === true)),
    othersFlaggedBySubject: bySubject,
    flaggedOthers: wrong.map((c) => c.entry.id),
    missedHostile: hostile.filter((c) => c.flagged === 0).map((c) => c.entry.id),
  };
}

/**
 * `check`'s report on `split`, which must be `tune`: held-out numbers come
 * only from {@link heldOutHostilityReport}, as the harness's do.
 *
 * @throws {Error} for `held-out`.
 */
export async function hostilityReport(
  check: HostilityCheck,
  split: Split,
  corpus: Corpus = loadCorpus(),
): Promise<HostilityReport> {
  if (split === 'held-out')
    throw new Error('Held-out numbers come only from heldOutHostilityReport.');
  return report(check, split, corpus);
}

/** `check`'s report on `held-out`: read once its bar is set on `tune`. */
export function heldOutHostilityReport(
  check: HostilityCheck,
  corpus: Corpus = loadCorpus(),
): Promise<HostilityReport> {
  return report(check, 'held-out', corpus);
}
