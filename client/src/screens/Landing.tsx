/**
 * The landing page (ADR-0078): what a new visitor sees before first run.
 *
 * One scene read top to bottom over a painted background: sky, canopy, trunks,
 * soil and roots, then the mycelial network. Each feature is explained through
 * a case study, in small pieces a reader can take in at a glance. Its one
 * action, Start a Group, hands over to first run: the install guide on an
 * iPhone or iPad, the pilot notice everywhere else.
 *
 * It creates no keys and stores nothing. Its words are `messages.landing`, and
 * its look is `src/styles/landing.css`.
 */
import { type ReactNode, useId } from 'react';
import { Button } from 'react-aria-components';

import { messages } from '../app/messages';

const text = messages.landing;

/** Props for {@link Landing}. */
export interface LandingProps {
  /** Moves on to first run: the install guide or the pilot notice. */
  readonly onStart: () => void;
}

/** A line marked as something shared, or something that divides. */
interface Marked {
  readonly shared: boolean;
  readonly lead: string;
  readonly rest: string;
}

/** A short heading over one line of text. */
interface Titled {
  readonly title: string;
  readonly body: string;
}

/** A card of paper over the painting, with the section's name above its heading. */
function Card(props: {
  readonly name: string;
  readonly kind?: string;
  readonly title: string;
  readonly headingId: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { name, kind, title, headingId, className = 'lp-prose', children } = props;
  return (
    <div className={`lp-win ${className}`}>
      <p className="lp-eyebrow">
        {name}
        {kind === undefined ? null : <span className="lp-kind">{kind}</span>}
      </p>
      <h2 id={headingId} tabIndex={-1}>
        {title}
      </h2>
      {children}
    </div>
  );
}

/** Lines marked shared or dividing. The mark is drawn in CSS; the words carry the meaning. */
function Tally({ lines }: { readonly lines: readonly Marked[] }) {
  return (
    <ul className="lp-tally">
      {lines.map((line) => (
        <li key={line.lead} className={line.shared ? 'lp-shared' : 'lp-apart'}>
          <b>{line.lead}</b> {line.rest}
        </li>
      ))}
    </ul>
  );
}

/** Two things side by side. */
function Pair({ sides }: { readonly sides: readonly Titled[] }) {
  return (
    <div className="lp-pair">
      {sides.map((side) => (
        <div key={side.title}>
          <h3>{side.title}</h3>
          <p>{side.body}</p>
        </div>
      ))}
    </div>
  );
}

/** Short points, each a heading and a line. */
function Points({ points }: { readonly points: readonly Titled[] }) {
  return (
    <ul className="lp-plain">
      {points.map((point) => (
        <li key={point.title}>
          <h3>{point.title}</h3>
          <p>{point.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** The Dispatch case study: one post, voted up level by level until it stops. */
function DispatchStudy({ headingId }: { readonly headingId: string }) {
  const study = text.dispatch;
  return (
    <div className="lp-wrap">
      <Card name={study.name} kind={text.caseStudy} title={study.title} headingId={headingId}>
        <p>{study.intro}</p>
      </Card>
      <ol className="lp-steps" aria-label={study.stepsLabel}>
        {study.steps.map((step) => (
          <li key={step.where} className="lp-win">
            <p className="lp-where">{step.where}</p>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            <p className={step.passed ? 'lp-verdict lp-yes' : 'lp-verdict lp-stop'}>
              {step.verdict}
            </p>
          </li>
        ))}
      </ol>
      <p className="lp-win lp-pullquote">{study.takeaway}</p>
    </div>
  );
}

/** The Reconcile case study: two Groups, what divides them, what they share. */
function ReconcileStudy({ headingId }: { readonly headingId: string }) {
  const study = text.reconcile;
  const groups = study.groups.map((group) => ({ title: group.name, body: group.about }));
  return (
    <div className="lp-wrap lp-second">
      <Card name={study.name} kind={text.caseStudy} title={study.title} headingId={headingId}>
        <Pair sides={groups} />
        <Tally lines={study.tally} />
        <h3>{study.thenTitle}</h3>
        <ol className="lp-then">
          {study.then.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        <p>{study.after}</p>
        <p className="lp-caption">{study.note}</p>
      </Card>
    </div>
  );
}

/** Documents: what they can be, two short stories, and how a vote works. */
function DocumentsStudy({ headingId }: { readonly headingId: string }) {
  const study = text.documents;
  return (
    <div className="lp-wrap">
      <Card
        name={study.name}
        kind={study.kind}
        title={study.title}
        headingId={headingId}
        className="lp-notice"
      >
        <ul className="lp-chips" aria-label={study.kindsLabel}>
          {study.kinds.map((kind) => (
            <li key={kind}>{kind}</li>
          ))}
        </ul>
        <Pair sides={study.cases} />
        <h3>{study.voteTitle}</h3>
        <ul className="lp-scale" aria-label={study.scaleLabel}>
          {messages.ballot.scores.map((label, score) => (
            <li key={label} className={`lp-s${String(score)}`}>
              <b>{String(score)}</b> {label}
            </li>
          ))}
        </ul>
        <Tally lines={study.rules} />
        <dl className="lp-levels">
          {messages.levels.names.map((level, index) => (
            <div key={level}>
              <dt>{level}</dt>
              <dd>{study.levels[index]}</dd>
            </div>
          ))}
        </dl>
        <p className="lp-caption">{study.levelsNote}</p>
      </Card>
    </div>
  );
}

/**
 * Brings a section into view and moves focus to its heading, so a keyboard or
 * screen-reader user lands where a sighted one does. It never touches the
 * address bar: routes live after `#`, and this page has none.
 */
function jumpTo(heading: HTMLElement | null): void {
  if (heading === null) return;
  heading.scrollIntoView({ block: 'start' });
  heading.focus({ preventScroll: true });
}

/** The landing page. */
export function Landing({ onStart }: LandingProps) {
  const id = useId();
  const ids = {
    dispatch: `${id}dispatch`,
    reconcile: `${id}reconcile`,
    documents: `${id}documents`,
    privacy: `${id}privacy`,
    network: `${id}network`,
    begin: `${id}begin`,
  };
  const jump = (headingId: string) => () => {
    jumpTo(document.getElementById(headingId));
  };
  return (
    <div className="lp">
      <header className="lp-sky">
        <div className="lp-wrap">
          <nav className="lp-topbar" aria-label={text.nav.label}>
            <Button className="lp-pill" onPress={jump(ids.dispatch)}>
              {text.nav.dispatch}
            </Button>
            <Button className="lp-pill" onPress={jump(ids.reconcile)}>
              {text.nav.reconcile}
            </Button>
            <Button className="lp-pill" onPress={jump(ids.documents)}>
              {text.nav.documents}
            </Button>
            <Button className="lp-pill" onPress={jump(ids.privacy)}>
              {text.nav.privacy}
            </Button>
          </nav>
          <div className="lp-hero">
            <h1>{text.title}</h1>
            <div className="lp-win lp-intro">
              <p className="lp-define">
                <i>{text.partOfSpeech}</i> {text.definition}
              </p>
              <p className="lp-lede">{text.lede}</p>
              <ul className="lp-lede lp-points">
                {text.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <div className="lp-actions">
                <Button className="lp-button" onPress={onStart}>
                  {text.start}
                </Button>
                <Button className="lp-link" onPress={jump(ids.dispatch)}>
                  {text.seeIt}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main>
        <section className="lp-canopy" aria-labelledby={ids.dispatch}>
          <DispatchStudy headingId={ids.dispatch} />
          <ReconcileStudy headingId={ids.reconcile} />
        </section>

        <section className="lp-understory" aria-labelledby={ids.documents}>
          <DocumentsStudy headingId={ids.documents} />
        </section>

        <section className="lp-soil" aria-labelledby={ids.privacy}>
          <div className="lp-wrap">
            <Card
              name={text.privacy.name}
              kind={text.privacy.kind}
              title={text.privacy.title}
              headingId={ids.privacy}
            >
              <Pair sides={text.privacy.pair} />
              <Points points={text.privacy.points} />
            </Card>
          </div>
        </section>

        <div className="lp-deep">
          <section aria-labelledby={ids.network}>
            <div className="lp-wrap">
              <Card name={text.network.name} title={text.network.title} headingId={ids.network}>
                <p>{text.network.intro}</p>
                <Points points={text.network.points} />
              </Card>
            </div>
          </section>

          <section className="lp-bedrock" aria-labelledby={ids.begin}>
            <div className="lp-wrap">
              <div className="lp-win lp-prose">
                <h2 id={ids.begin}>{text.begin.title}</h2>
                <p>{text.begin.body}</p>
                <div className="lp-actions">
                  <Button className="lp-button" onPress={onStart}>
                    {text.start}
                  </Button>
                </div>
              </div>
            </div>
            <footer className="lp-wrap lp-foot">
              <span className="lp-wordmark">{text.title}</span>
              <p>{text.footer}</p>
            </footer>
          </section>
        </div>
      </main>
    </div>
  );
}
