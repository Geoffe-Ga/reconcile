/**
 * Private drafts (ADR-0073; docs/spec/phase-1-spec.md §7 and §8): a Proposal
 * or a version someone is still writing, kept on this device only.
 *
 * A group holds at most one draft per target: the Atom a Proposal would
 * change, or the open Proposal a version would join (#72), whose text is all
 * a version keeps. Drafts live inside the group's own record, so whatever
 * removes the group from the device, such as Leave or Erase, removes its
 * drafts with it. Nothing here touches the network: a draft reaches the relay
 * only as the Proposal or version it becomes, and queuing that clears it.
 */

/** What someone has typed into the composer so far, as typed. */
export interface Draft {
  readonly title: string;
  readonly why: string;
  readonly text: string;
  /** The discussion link field, as typed, blank for none. */
  readonly link: string;
}

/** A group's drafts by target. Absent from records kept before drafts existed. */
export type DraftShelf = ReadonlyMap<string, Draft>;

/** True for a value shaped like a {@link Draft}: four strings, nothing missing. */
export function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false;
  const { title, why, text, link } = value as Record<string, unknown>;
  return [title, why, text, link].every((field) => typeof field === 'string');
}

/** The draft a group's record holds for `target`, or undefined for none or for one that isn't whole. */
export function draftIn(
  group: { readonly drafts?: DraftShelf },
  target: string,
): Draft | undefined {
  const draft = group.drafts?.get(target);
  return isDraft(draft) ? draft : undefined;
}

/** A copy of `drafts` with `target`'s draft set to `draft`, or removed when it is null. */
export function withDraft(
  drafts: DraftShelf | undefined,
  target: string,
  draft: Draft | null,
): Map<string, Draft> {
  const next = new Map(drafts);
  if (draft === null) next.delete(target);
  else next.set(target, draft);
  return next;
}

/** Where drafts are kept: the device's store (`openStore`), or anything that keeps them like it. */
export interface DraftStore {
  /** The group's draft for `target`, or undefined. */
  readDraft(groupId: string, target: string): Promise<Draft | undefined>;
  /** Keeps `draft` as the group's draft for `target`, or removes it when null. */
  writeDraft(groupId: string, target: string, draft: Draft | null): Promise<void>;
}

/** One group's drafts, as the composer uses them. */
export interface GroupDrafts {
  /** The draft for `target`, or undefined. */
  load(target: string): Promise<Draft | undefined>;
  /** Keeps `draft` for `target`, replacing any earlier one. */
  save(target: string, draft: Draft): Promise<void>;
  /** Removes the draft for `target`, if any. */
  clear(target: string): Promise<void>;
}

/** The drafts of group `groupId` in `store`. */
export function groupDrafts(store: DraftStore, groupId: string): GroupDrafts {
  return {
    load: (target) => store.readDraft(groupId, target),
    save: (target, draft) => store.writeDraft(groupId, target, draft),
    clear: (target) => store.writeDraft(groupId, target, null),
  };
}
