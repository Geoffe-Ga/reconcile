import { useId } from 'react';
import { Button } from 'react-aria-components';

import { messages } from '../app/messages';
import { PageHeader } from '../app/ui';

/** Props for {@link PilotNotice}. */
export interface PilotNoticeProps {
  /** Records the acceptance; the app opens after it. */
  readonly onAccept: () => void;
}

type Topic = (typeof messages.notice.topics)[number];

function NoticeTopic({ topic }: { readonly topic: Topic }) {
  const heading = useId();
  return (
    <section className="section" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {topic.heading}
      </h2>
      <div className="stack">
        {topic.lines.map((line) => (
          <p key={line} className="lede">
            {line}
          </p>
        ))}
        {topic.list.length === 0 ? null : (
          <ul className="bullets lede">
            {topic.list.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * The pilot notice (ADR-0056, spec §8.1): one screen on what's stored, what
 * the relay can and can't see, that data can be lost, and that this is a
 * test. Nothing creates keys until the person taps I understand.
 */
export function PilotNotice({ onAccept }: PilotNoticeProps) {
  return (
    <main className="shell">
      <PageHeader
        eyebrow={messages.notice.eyebrow}
        title={messages.notice.title}
        pageTitle={messages.notice.pageTitle}
      />
      <p className="lede">{messages.notice.lede}</p>
      <div className="sections">
        {messages.notice.topics.map((topic) => (
          <NoticeTopic key={topic.heading} topic={topic} />
        ))}
      </div>
      <Button className="button button-primary" onPress={onAccept}>
        {messages.notice.accept}
      </Button>
    </main>
  );
}
