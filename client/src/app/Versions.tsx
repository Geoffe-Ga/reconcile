/**
 * A Proposal's versions, side by side (DESIGN.md, Ballot; spec §8; ADR-0004).
 *
 * Every version on the ballot shows the same way: "Version N · <name>", what
 * it does when it adds or removes a section (#75), its word diff against the
 * section's text now, and "How it will read". A removal's diff strikes the
 * whole section through and has nothing to read; an add's marks its whole text
 * as added. Nobody filters which versions voters see. Wide screens set them in
 * equal columns and phones stack them (src/styles/proposals.css).
 */
import { type ReactNode, useId } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';

import { messages } from './messages';
import type { RulesView } from './optInLines';
import { MotionTitle } from './stewards';
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

/**
 * A version's change: a word diff against `current`, and how it will read
 * unless it removes the section. With nothing to compare, its text as it
 * reads, and nothing at all for a removal.
 */
function Change({ version, current }: Omit<VersionCardProps, 'children'>) {
  const { text } = version;
  if (current === null) return text === '' ? null : <AtomText text={text} className="atom-card" />;
  return (
    <>
      <WordDiff current={current} proposed={text} />
      {text === '' ? null : <ReadsAs text={text} level={4} />}
    </>
  );
}

/** What a rules ballot decides passing does, and the webhook it would set, by its last 4 only (#117). */
function RulesLines({ rules }: { readonly rules: RulesView }) {
  return (
    <>
      <p className="caption">{rules.line}</p>
      {rules.tail === null ? null : (
        <p className="caption">
          {messages.optIns.webhookEnding} <span className="webhook-tail">{rules.tail}</span>
        </p>
      )}
    </>
  );
}

/** A version's heading: "Version N · <name>", or what a steward, rules, dissolve or move ballot decides. */
function VersionHeading({ version }: { readonly version: VersionView }) {
  const { steward, rules, dissolve, decision, move } = version;
  if (move !== undefined) return <>{move.line}</>;
  if (steward !== undefined) return <MotionTitle motion={steward.motion} />;
  if (rules !== undefined) return <>{rules.title}</>;
  if (dissolve !== undefined) return <>{dissolve.title}</>;
  if (decision !== undefined) return <bdi>{decision.title}</bdi>;
  return (
    <>
      {messages.ballot.version(version.number)} {messages.ballot.separator}{' '}
      <bdi>{version.author}</bdi>
    </>
  );
}

/**
 * Under the heading: the version's change, what passing a steward, rules or
 * dissolve ballot does, or the section a move moves, as it reads (#103).
 */
function VersionBody({ version, current }: Omit<VersionCardProps, 'children'>) {
  const { steward, rules, dissolve, decision, move } = version;
  if (move !== undefined) {
    if (move.text === null) return null;
    return <AtomText text={move.text} className="atom-card atom-card-current" />;
  }
  if (steward !== undefined) return <p className="caption">{steward.line}</p>;
  if (rules !== undefined) return <RulesLines rules={rules} />;
  const line = dissolve?.line ?? decision?.line;
  if (line !== undefined) return <p className="caption">{line}</p>;
  return <Change version={version} current={current} />;
}

/**
 * One version: its heading, what it does when it adds or removes a section
 * (#75), its change, and whatever goes under it. A steward ballot's one
 * version is headed by what it decides, "Make <name> steward (seat N)", with
 * what passing does in place of a change (#102), and so is a rules ballot's,
 * "Turn on the Discord chat bot" (#117), and a dissolve ballot's, "Dissolve
 * the group" (#108).
 */
function VersionCard({ version, current, children }: VersionCardProps) {
  const heading = useId();
  return (
    <section className="version" aria-labelledby={heading}>
      <h3 id={heading} className="version-heading">
        <VersionHeading version={version} />
      </h3>
      {version.does === undefined ? null : <p className="version-does">{version.does}</p>}
      <VersionBody version={version} current={current} />
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
