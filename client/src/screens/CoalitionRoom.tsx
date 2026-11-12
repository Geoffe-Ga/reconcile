/**
 * A coalition's room (`#/c/{coalitionId}/room`; #125, ADR-0011, ADR-0009).
 *
 * One small room per coalition, where people from all its member groups talk
 * in plain text under their coalition names: a list and a box. Messages run
 * oldest at the top to newest at the bottom, each with its author's
 * coalition name and the relay's time, its text plain inside `<bdi>`, line
 * breaks kept and never read as Markdown or links. What this device wrote
 * and the relay doesn't have yet shows at the end with its `SendStatus`.
 * Someone bound to a seat writes in the box at the bottom; someone who
 * hasn't joined is offered Take part there first, and anyone else reads.
 * New messages from others are announced politely, and only while the
 * person is at the bottom, so reading back is never interrupted.
 */
import { type SyntheticEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Form } from 'react-aria-components';

import { TakePart } from '../app/CoalitionSection';
import { holdPresses } from '../app/holdPresses';
import { messages } from '../app/messages';
import type { RoomStanding, RoomView } from '../app/room';
import { SendStatus } from '../app/SendStatus';
import { formatSyncedAt, MINUTE_MS, minuteIso } from '../app/time';
import { BackLink, Field, PageHeader } from '../app/ui';
import { useSaving } from '../app/useSaving';
import { checkMessage, type RoomMessage } from '../engine/room';

const { room } = messages;

/** Props for {@link CoalitionRoom}. */
export interface CoalitionRoomProps {
  /** The room as this device reads it (`roomView`). */
  readonly view: RoomView;
  /** The relay's minute now, as this device estimates it: a message's time shows its day unless it's today's. */
  readonly now: number;
  /** Whether the last sync pass reached the relay, for what waits to send. */
  readonly reachable: boolean;
  /** Queues `text` as a message; rejects when it couldn't be saved. */
  readonly onSend: (text: string) => Promise<void>;
  /** Takes part under the seat of the group `view.standing` names, as `name`. */
  readonly onTakePart: (name: string) => Promise<void>;
}

/** Within this many pixels of the end of the page counts as the bottom. */
const BOTTOM_SLACK = 64;

/** Whether the page is scrolled to its end. */
function isAtBottom(): boolean {
  const page = document.documentElement;
  return page.scrollTop + window.innerHeight >= page.scrollHeight - BOTTOM_SLACK;
}

/** Scrolls the page to its end, where the newest message and the box are. */
function toBottom(): void {
  const page = document.documentElement;
  page.scrollTop = page.scrollHeight;
}

/** What the live region says of `fresh`: who wrote the one, or how many came. */
function arrivalLine(fresh: readonly RoomMessage[]): string {
  const [only] = fresh;
  return fresh.length === 1 && only !== undefined
    ? room.newFrom(only.name, only.text)
    : room.newMessages(fresh.length);
}

/**
 * Opens at the bottom, follows new messages there while the person is at the
 * bottom, and returns the polite line announcing what others wrote since:
 * nothing while they've scrolled up to read back.
 */
function useArrivals(list: readonly RoomMessage[], me: string): string {
  const [line, setLine] = useState('');
  const seen = useRef<ReadonlySet<string> | null>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const onScroll = (): void => {
      atBottom.current = isAtBottom();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = new Set(list.map((message) => message.id));
    if (before === null || !atBottom.current) {
      if (before === null) toBottom();
      return;
    }
    const added = list.filter((message) => !before.has(message.id));
    if (added.length === 0) return;
    toBottom();
    const fresh = added.filter((message) => message.author !== me);
    if (fresh.length > 0) setLine(arrivalLine(fresh));
  }, [list, me]);
  return line;
}

/** One message: who wrote it and when, then its text as written. */
function Message({ message, now }: { readonly message: RoomMessage; readonly now: number }) {
  return (
    <li className="room-message">
      <p className="room-message-head">
        <bdi className="room-author">{message.name}</bdi>
        <time className="room-time" dateTime={minuteIso(message.received)}>
          {formatSyncedAt(message.received * MINUTE_MS, now * MINUTE_MS)}
        </time>
      </p>
      <p className="room-text">
        <bdi>{message.text}</bdi>
      </p>
    </li>
  );
}

/** The messages, oldest first, then what waits to send; or one line before anyone writes. */
function Messages({
  view,
  now,
  reachable,
}: Pick<CoalitionRoomProps, 'view' | 'now' | 'reachable'>) {
  if (view.messages.length === 0 && view.pending.length === 0) {
    return <p className="room-empty">{room.empty}</p>;
  }
  return (
    <ol className="room-messages" aria-label={room.listLabel}>
      {view.messages.map((message) => (
        <Message key={message.id} message={message} now={now} />
      ))}
      {view.pending.map((message) => (
        <li key={message.id} className="room-message room-pending">
          <p className="room-message-head">
            <bdi className="room-author">{view.myName}</bdi>
          </p>
          <p className="room-text">
            <bdi>{message.text}</bdi>
          </p>
          <SendStatus pending reachable={reachable} sent={false} />
        </li>
      ))}
    </ol>
  );
}

/** The field's error for `text`: none while it fits. */
function messageError(text: string): string | null {
  const problem = checkMessage(text);
  if (problem === null) return null;
  return problem === 'empty' ? room.emptyMessage : room.longMessage;
}

/** The box and Send. A message that was saved clears the box; one that wasn't keeps it. */
function Composer({ onSend }: Pick<CoalitionRoomProps, 'onSend'>) {
  const { run, running, outcome } = useSaving(onSend);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const text = new FormData(form).get('text');
    if (typeof text !== 'string') return;
    void run(text).then((saved) => {
      if (!saved) return;
      form.reset();
      toBottom();
    });
  };
  return (
    <Form className="form room-composer" onSubmit={submit}>
      <Field
        name="text"
        label={room.messageLabel}
        hint={room.messageHint}
        multiline
        inputClassName="input-message"
        autoComplete="off"
        isRequired
        validate={messageError}
      />
      {outcome === 'failed' ? (
        <p role="alert" className="form-error">
          {room.failed}
        </p>
      ) : null}
      <div className="row form-actions" onPointerDownCapture={holdPresses(running)}>
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {room.send}
        </Button>
      </div>
    </Form>
  );
}

/** What sits at the bottom: the box for a participant, Take part for whoever may, else a line. */
function Bottom({
  standing,
  onSend,
  onTakePart,
}: Pick<CoalitionRoomProps, 'onSend' | 'onTakePart'> & { readonly standing: RoomStanding }) {
  switch (standing.kind) {
    case 'writes':
      return <Composer onSend={onSend} />;
    case 'take-part':
      return (
        <div className="stack room-take-part">
          <p>{room.takePartFirst}</p>
          <TakePart onTakePart={onTakePart} />
        </div>
      );
    case 'joining':
      return <p className="room-note">{room.joining}</p>;
    case 'reads':
      return <p className="room-note">{room.reads}</p>;
  }
}

/** The coalition's room (#125): who can read it, its messages, then the box. */
export function CoalitionRoom({ view, now, reachable, onSend, onTakePart }: CoalitionRoomProps) {
  const announcement = useArrivals(view.messages, view.me);
  return (
    <main className="shell room">
      <BackLink to={{ name: 'coalition', coalitionId: view.coalitionId }} label={view.name} />
      <PageHeader eyebrow={room.eyebrow} title={view.name} pageTitle={room.pageTitle} />
      <p className="lede">{room.note}</p>
      <Messages view={view} now={now} reachable={reachable} />
      <p role="status" className="visually-hidden room-announcer">
        {announcement}
      </p>
      <Bottom standing={view.standing} onSend={onSend} onTakePart={onTakePart} />
    </main>
  );
}
