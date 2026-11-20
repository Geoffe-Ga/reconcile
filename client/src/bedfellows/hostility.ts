/**
 * The shared-enemy check (#481; ADR-0080 §6): a claim that is mainly
 * hostility toward a group of people can't be an entry's reason, so a feed
 * that leads outward from one shared point never leads through a shared enemy.
 *
 * It asks a stance model one zero-shot question, {@link HOSTILITY_HYPOTHESIS},
 * with the claim as premise, so no third model is downloaded: a claim is
 * flagged when the model's entailment reaches `THRESHOLDS.hostility.entails`.
 * `harness.ts`'s `hostilityReport` measures any check against the corpus's `hostile`
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
import type { StanceLabels } from './judge';
import type { PairClassifier } from './runtime';
import { THRESHOLDS } from './thresholds';
import type { HostilityCheck } from './types';

/** The zero-shot question, the claim as premise and this as hypothesis (#481's wording). */
export const HOSTILITY_HYPOTHESIS = 'This is mainly hostility toward a group of people.';

/**
 * Whether the pipeline holds back claims the check flags. Off: on the
 * corpus no candidate model separates hostility toward people from anger at
 * the powerful (`thresholds.ts`, ADR-0080 §6), and none ships. Switching it
 * on needs a model that does, measured by `harness.ts`'s `heldOutHostilityReport`,
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
