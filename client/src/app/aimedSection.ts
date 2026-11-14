/**
 * Opening a section from search (#445): its Document opens scrolled to it.
 * Search aims at the section in memory, never in the address bar, and the
 * Document view scrolls to it once that section shows, then forgets it.
 */
import { useEffect } from 'react';

/** The section search last aimed at, until a Document shows it. */
let aimed: string | null = null;

/** Aims at the section `atomId`: the next Document view that shows it scrolls to it. */
export function aimAt(atomId: string): void {
  aimed = atomId;
}

/** The id a section's element carries, for search to scroll to. */
export function sectionAnchor(atomId: string): string {
  return `section-${atomId}`;
}

/** Scrolls to the aimed-at section once it's among `atoms`, and forgets the aim. */
export function useAimedSection(atoms: readonly { readonly id: string }[]): void {
  useEffect(() => {
    const target = aimed;
    if (target === null || !atoms.some((atom) => atom.id === target)) return;
    aimed = null;
    document.getElementById(sectionAnchor(target))?.scrollIntoView({ block: 'start' });
  }, [atoms]);
}
