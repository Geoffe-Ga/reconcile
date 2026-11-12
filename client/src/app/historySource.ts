/**
 * Where a section's history sheet and a Document's change log read from
 * (#104): a section's history, worked out once its sheet opens, whose names
 * its entries carry, and where each Proposal's full result is. A group's
 * comes from its own folded log; a coalition's from the coalition's, with
 * each motion's result in a member group on this device whose seat decides
 * it (CoalitionScreens.tsx).
 */
import type { GroupState } from '../engine/fold';
import { type KeptTallies, sectionHistory, type SectionHistory } from '../engine/history';
import type { MotionItem } from './coalitionHome';
import { routeHref } from './router';

/** What a section's history sheet reads. */
export interface HistorySource {
  /** Section `atomId`'s history, worked out when its sheet opens. */
  readonly historyOf: (atomId: string) => SectionHistory;
  /** Whose names the entries carry: the group's members, or the coalition's participants (#120). */
  readonly names: Pick<GroupState, 'members' | 'former'>;
  /** Where "See the full result" goes for a Proposal, or null where this device has none to open. */
  readonly resultHref: (proposalId: string) => string | null;
}

/**
 * A group's history source: its own log's histories, with a cleared
 * archive's kept tallies (#108) when it has them, and each Proposal's result
 * on its own page in the group.
 */
export function groupHistory(state: GroupState, kept: KeptTallies = {}): HistorySource {
  const groupId = state.group ?? '';
  return {
    historyOf: (atomId) => sectionHistory(state, atomId, kept),
    names: state,
    resultHref: (proposalId) => routeHref({ name: 'proposal', groupId, proposalId }),
  };
}

/**
 * A coalition's history source (#120): its own log's histories, whose
 * entries carry its participants' names, and each motion's result in the
 * member group on this device whose seat decides it (`motions`, as the
 * coalition home lists them), where that group's own result and its
 * coalition result live; none where no group here decided it.
 */
export function coalitionHistory(
  state: GroupState,
  motions: readonly Pick<MotionItem, 'id' | 'groupId'>[],
): HistorySource {
  return {
    historyOf: (atomId) => sectionHistory(state, atomId),
    names: state,
    resultHref: (proposalId) => {
      const groupId = motions.find((motion) => motion.id === proposalId)?.groupId ?? null;
      return groupId === null ? null : routeHref({ name: 'proposal', groupId, proposalId });
    },
  };
}
