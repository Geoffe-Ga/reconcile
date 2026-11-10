/**
 * A Proposal's versions, side by side (DESIGN.md, Ballot; spec §8; ADR-0004).
 *
 * Every version on the ballot shows the same way: "Version N · <name>", its
 * word diff against the section's text now, and "How it will read". Nobody
 * filters which versions voters see. Wide screens set them in equal columns
 * and phones stack them (src/styles/proposals.css).
 */
import { type ReactNode, useId } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';

import { messages } from './messages';
import { AtomText } from './text/AtomText';
import { WordDiff } from './text/WordDiff';
import type { VersionView } from './versionViews';

/** A version's text as the Document will show it, one tap away from the diff. */
export function ReadsAs({ text, level }: { readonly text: string; readonly level: 3 | 4 }) {
  return (
    <Disclosure className="reads-as">
      <Heading level={level} className="reads-as-heading">
        <Button slot="trigger" className="reads-as-toggle">
          {messages.proposal.readsAs}
        </Button>
      </Heading>
      <DisclosurePanel>
        <AtomText text={text} className="atom-card" />
      </DisclosurePanel>
    </Disclosure>
  );
}

interface VersionCardProps {
  readonly version: VersionView;
  readonly current: string | null;
  readonly children: ReactNode;
}

/** One version: its heading, its change, and whatever goes under it. */
function VersionCard({ version, current, children }: VersionCardProps) {
  const heading = useId();
  return (
    <section className="version" aria-labelledby={heading}>
      <h3 id={heading} className="version-heading">
        {messages.ballot.version(version.number)} {messages.ballot.separator}{' '}
        <bdi>{version.author}</bdi>
      </h3>
      {current === null ? (
        <AtomText text={version.text} className="atom-card" />
      ) : (
        <>
          <WordDiff current={current} proposed={version.text} />
          <ReadsAs text={version.text} level={4} />
        </>
      )}
      {children}
    </section>
  );
}

/** Props for {@link VersionList}. */
export interface VersionListProps {
  readonly versions: readonly VersionView[];
  /** The section's text now, which each version is compared with, or null to show each text alone. */
  readonly current: string | null;
  /** What goes under each version, such as its score pills. */
  readonly children?: (version: VersionView) => ReactNode;
}

/** The versions in ballot order, in equal columns on wide screens and stacked on phones. */
export function VersionList({ versions, current, children }: VersionListProps) {
  return (
    <div className={`versions versions-${String(versions.length)}`}>
      {versions.map((version) => (
        <VersionCard key={version.id} version={version} current={current}>
          {children?.(version)}
        </VersionCard>
      ))}
    </div>
  );
}
