/**
 * A priority vote's options (#107; DESIGN.md, Ballot): each option is one
 * card, its text set as plain text in `<bdi>`, never as Markdown, with
 * whatever goes under it, such as its score pills and consent meter. Phones
 * stack the cards and wide screens set them in columns (src/styles/proposals.css).
 */
import { type ReactNode, useId } from 'react';

import { VersionList } from './Versions';
import type { VersionView } from './versionViews';

/** One option: its text as the card's heading, then whatever goes under it. */
function OptionCard({ option, children }: { option: VersionView; children: ReactNode }) {
  const heading = useId();
  return (
    <section className="version option" aria-labelledby={heading}>
      <h3 id={heading} className="option-text">
        <bdi>{option.text}</bdi>
      </h3>
      {children}
    </section>
  );
}

/** Props for {@link OptionList}. */
export interface OptionListProps {
  /** The options, in ballot order. */
  readonly options: readonly VersionView[];
  /** What goes under each option, such as its score pills. */
  readonly children?: (option: VersionView) => ReactNode;
}

/** The options in ballot order: stacked on phones, in columns on wide screens. */
export function OptionList({ options, children }: OptionListProps) {
  return (
    <div className={`options options-${String(options.length)}`}>
      {options.map((option) => (
        <OptionCard key={option.id} option={option}>
          {children?.(option)}
        </OptionCard>
      ))}
    </div>
  );
}

/** Props for {@link ChoiceList}. */
export interface ChoiceListProps {
  readonly versions: readonly VersionView[];
  /** The section's text now, which each version is compared with, or null to show each alone. */
  readonly current: string | null;
  /** `versions` for versions with their changes, `options` for a priority vote's options. */
  readonly layout: 'versions' | 'options';
  /** What goes under each one, such as its score pills or consent meter; nothing when left out. */
  readonly children?: (version: VersionView) => ReactNode;
}

/** Nothing under a version or option. */
const nothing = (): ReactNode => null;

/** What a ballot holds: versions with their changes, or a priority vote's options (#107). */
export function ChoiceList({ versions, current, layout, children = nothing }: ChoiceListProps) {
  return layout === 'options' ? (
    <OptionList options={versions}>{children}</OptionList>
  ) : (
    <VersionList versions={versions} current={current}>
      {children}
    </VersionList>
  );
}
