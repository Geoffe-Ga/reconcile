import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Button,
  CheckboxButton,
  CheckboxField,
  CheckboxGroup,
  Form,
  Label,
  Link,
  Text,
} from 'react-aria-components';

import { holdPresses } from '../app/holdPresses';
import { messages } from '../app/messages';
import { routeHref } from '../app/router';
import { Field, PageHeader } from '../app/ui';
import {
  type ApplyValues,
  documentCopies,
  DOCUMENTS_MAX,
  type DocumentsProblem,
  documentsProblem,
  MESSAGE_MAX,
  NAME_MAX,
} from '../door/apply';
import {
  type DoorReader,
  type DoorView,
  type OpenPage,
  parseDoorPayload,
  readDoor,
} from '../door/page';
import type { CardGroup, CardValues } from '../app/reconcile';
import { nfcLength } from '../engine/text';
import type { PersonalText } from '../store/personal';
import { type DoorCardStep, ReconcileAtDoor } from './ReconcileCard';

/** A personal Document the picker offers (#425): its id for the checkbox, and the words a copy carries. */
export type PersonalChoice = Pick<PersonalText, 'id' | 'title' | 'text'>;

/** Props for {@link FrontDoor}. */
export interface FrontDoorProps {
  /** What follows `#door/` in the address bar, as written. */
  readonly payload: string;
  /** The relay and the seal: all reading the page reaches. */
  readonly reader: DoorReader;
  /** Whether this device has already asked to join at the door `address` names, in base64url. */
  readonly asked: (address: string) => boolean;
  /** Send: seals and posts the application, keeping its reply key on this device. */
  readonly onApply: (
    address: Uint8Array,
    page: OpenPage,
    values: ApplyValues,
  ) => Promise<'sent' | 'failed'>;
  /** This device's personal Documents, oldest first, which the form offers to send a copy of (#425). */
  readonly documents: readonly PersonalChoice[];
  /**
   * This device's groups that may propose reconciling with the door's group
   * (#426): none for a device in no group, and never the door's own.
   */
  readonly cardGroups: readonly CardGroup[];
  /** Propose reconciling's Submit: queues the group's reconcile Proposal; its post leaves the card here. */
  readonly onMakeCard: (
    address: Uint8Array,
    page: OpenPage,
    groupId: string,
    values: CardValues,
  ) => Promise<DoorCardStep>;
}

/** Where the page has got to: reading it, what it shows, or unable to reach the relay. */
type Phase = { readonly kind: 'loading' } | DoorView | { readonly kind: 'offline' };

/** Limits count code points after NFC, as the application's parser does. */
function required(missing: string, max: number, tooLong: string) {
  return (value: string): string | null => {
    const text = value.trim();
    if (text === '') return missing;
    return nfcLength(text) > max ? tooLong : null;
  };
}

const { door } = messages;
const checkName = required(door.nameMissing, NAME_MAX, door.nameTooLong(NAME_MAX));
const checkMessage = required(door.messageMissing, MESSAGE_MAX, door.messageTooLong(MESSAGE_MAX));

/**
 * A state with no page to show: "Front door", or another heading under that
 * eyebrow, one line, and maybe a second line or Try again.
 */
function Notice(props: {
  readonly title?: string;
  readonly line: string;
  readonly hint?: string;
  readonly onRetry?: () => void;
}) {
  const { title, line, hint, onRetry } = props;
  const header = title === undefined ? { title: door.pageTitle } : { eyebrow: door.eyebrow, title };
  return (
    <main className="shell">
      <PageHeader {...header} pageTitle={door.pageTitle} />
      <div className="stack">
        <p className="lede">{line}</p>
        {hint === undefined ? null : <p className="caption">{hint}</p>}
        {onRetry === undefined ? null : (
          <div>
            <Button className="button button-primary" onPress={onRetry}>
              {door.retry}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}

/** "Sent. If someone in <group> invites you, it shows on Your groups.", and the way there. */
function Sent(props: {
  readonly name: string;
  readonly parts: { readonly before: string; readonly after: string };
}) {
  const { name, parts } = props;
  return (
    <div className="stack">
      <p role="status" className="lede">
        {parts.before} <bdi>{name}</bdi> {parts.after}
      </p>
      <div>
        <Link className="button button-secondary" href={routeHref({ name: 'start' })}>
          {door.yourGroups}
        </Link>
      </div>
    </div>
  );
}

interface ApplyFormProps {
  readonly onSend: (values: ApplyValues) => Promise<'sent' | 'failed'>;
  readonly documents: readonly PersonalChoice[];
}

/** The form-error line a choice of Documents gets, by what's wrong with it. */
const PROBLEM: Readonly<Record<DocumentsProblem, string>> = {
  'too-many': door.documentsTooMany(DOCUMENTS_MAX),
  'too-long': door.documentsTooLong,
};

interface DocumentPickerProps {
  readonly documents: readonly PersonalChoice[];
  readonly chosen: readonly string[];
  readonly onChange: (chosen: string[]) => void;
  readonly problem: DocumentsProblem | null;
}

/**
 * "Send some of your own Documents with this" (#425; ADR-0077 §3): a
 * checkbox per personal Document, its title in `<bdi>`, none checked to
 * start, with one line saying who reads them, and the one `form-error` line
 * while the choice is too many or too long to go. Nothing for someone with
 * no personal Documents.
 */
function DocumentPicker({ documents, chosen, onChange, problem }: DocumentPickerProps) {
  const error = useId();
  if (documents.length === 0) return null;
  return (
    <CheckboxGroup
      className="door-documents"
      value={[...chosen]}
      onChange={onChange}
      isInvalid={problem !== null}
      {...(problem === null ? {} : { 'aria-describedby': error })}
    >
      <Label className="field-label">{door.documentsLabel}</Label>
      <Text slot="description" className="door-careful">
        {door.documentsHint}
      </Text>
      <ul className="door-documents-list">
        {documents.map(({ id, title }) => (
          <li key={id}>
            <CheckboxField value={id}>
              <CheckboxButton className="checkbox">
                <span className="checkbox-box" aria-hidden="true" />
                <bdi>{title}</bdi>
              </CheckboxButton>
            </CheckboxField>
          </li>
        ))}
      </ul>
      {problem === null ? null : (
        <p id={error} role="alert" className="form-error">
          {PROBLEM[problem]}
        </p>
      )}
    </CheckboxGroup>
  );
}

/** The copy the chosen Documents send, in the order Personal lists them, as Send seals it. */
function chosenCopies(documents: readonly PersonalChoice[], chosen: readonly string[]) {
  return documentCopies(documents.filter(({ id }) => chosen.includes(id)));
}

/** The form: the name to use, why, any Documents to send, the caution, and Send. One send at a time. */
function ApplyForm({ onSend, documents }: ApplyFormProps) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const copies = chosenCopies(documents, chosen);
  const problem = documentsProblem(copies);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A press React Aria delivers late, or a second press, finds it busy (#190).
    if (busy.current || problem !== null) return;
    busy.current = true;
    setRunning(true);
    setFailed(false);
    const values = { name, message, ...(copies.length === 0 ? {} : { documents: copies }) };
    void onSend(values).then((outcome) => {
      if (outcome === 'sent') return;
      busy.current = false;
      setRunning(false);
      setFailed(true);
    });
  };
  return (
    <Form className="form" onSubmit={submit}>
      <Field
        name="name"
        label={door.nameLabel}
        hint={door.nameHint}
        autoComplete="off"
        isRequired
        validate={checkName}
        value={name}
        onChange={setName}
      />
      <Field
        name="message"
        label={door.messageLabel}
        hint={door.messageHint(MESSAGE_MAX)}
        multiline
        isRequired
        validate={checkMessage}
        value={message}
        onChange={setMessage}
      />
      <DocumentPicker
        documents={documents}
        chosen={chosen}
        onChange={setChosen}
        problem={problem}
      />
      <p className="door-careful">{door.careful}</p>
      {failed ? (
        <p role="alert" className="form-error">
          {door.failed}
        </p>
      ) : null}
      <div className="row form-actions" onPointerDownCapture={holdPresses(running)}>
        <Button type="submit" className="button button-primary" isDisabled={running}>
          {door.send}
        </Button>
      </div>
    </Form>
  );
}

/** The group's words: the excerpt from its Document and, only when it chose, how many are in it. */
export function DoorExcerpt({ page }: { readonly page: OpenPage }) {
  return (
    <div className="card door-excerpt">
      <p className="eyebrow">{door.excerptLabel}</p>
      {page.excerpt === '' ? null : (
        <p className="invite-excerpt">
          <bdi>{page.excerpt}</bdi>
        </p>
      )}
      {page.count === undefined ? null : <p className="door-count">{door.people(page.count)}</p>}
    </div>
  );
}

interface OpenProps extends Pick<
  FrontDoorProps,
  'onApply' | 'documents' | 'cardGroups' | 'onMakeCard'
> {
  readonly address: Uint8Array;
  readonly page: OpenPage;
  readonly asked: boolean;
}

/**
 * An open door: the group's name, its excerpt, Propose reconciling with this
 * group for a device with a group that may (#426), then the form, or what
 * this device already sent.
 */
function Open(props: OpenProps) {
  const { address, page, asked, onApply, documents, cardGroups, onMakeCard } = props;
  const heading = useId();
  const [sent, setSent] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const onSend = async (values: ApplyValues) => {
    const outcome = await onApply(address, page, values);
    if (outcome === 'sent') setSent(true);
    return outcome;
  };
  if (reconciling) {
    return (
      <ReconcileAtDoor
        doorName={page.name}
        groups={cardGroups}
        onMake={(groupId, values) => onMakeCard(address, page, groupId, values)}
        onBack={() => {
          setReconciling(false);
        }}
      />
    );
  }
  return (
    <main className="shell">
      <PageHeader eyebrow={door.eyebrow} title={page.name} pageTitle={door.pageTitle} />
      <DoorExcerpt page={page} />
      {cardGroups.length === 0 ? null : (
        <div className="row">
          <Button
            className="button button-secondary"
            onPress={() => {
              setReconciling(true);
            }}
          >
            {door.proposeReconciling}
          </Button>
        </div>
      )}
      <section className="stack door-ask" aria-labelledby={heading}>
        <h2 id={heading} className="heading-3">
          {door.askHeading}
        </h2>
        {sent ? (
          <Sent name={page.name} parts={door.sent} />
        ) : asked ? (
          <Sent name={page.name} parts={door.asked} />
        ) : (
          <ApplyForm onSend={onSend} documents={documents} />
        )}
      </section>
    </main>
  );
}

/** Reads the door once per link and attempt; a damaged link reads nothing. */
function useDoor(address: Uint8Array | null, reader: DoorReader, key: string): Phase {
  const [answer, setAnswer] = useState<{ readonly key: string; readonly phase: Phase } | null>(
    null,
  );
  useEffect(() => {
    if (address === null) return;
    let live = true;
    const settle = (phase: Phase) => {
      if (live) setAnswer({ key, phase });
    };
    readDoor(reader, address).then(settle, () => {
      settle({ kind: 'offline' });
    });
    return () => {
      live = false;
    };
  }, [address, reader, key]);
  return answer?.key === key ? answer.phase : { kind: 'loading' };
}

/**
 * A group's front door (`#door/{address}`; ADR-0038, #121): the page its
 * address names, as plain text in `<bdi>`, never a member's name, then the
 * form to ask to join: the name to use, why, a copy of any personal
 * Documents the person checks (#425), and a caution, with no contact
 * field. A device in a group that may take a card also gets Propose
 * reconciling with this group, which opens the card's form (#426). Its page is only what the group's devices posted under the door's
 * key, read again on each visit; a closed door, or one with no page, reads
 * "This front door is closed." with no form. A device that already asked
 * here says so instead of the form. The tab's title never carries the
 * group's name.
 */
export function FrontDoor(props: FrontDoorProps) {
  const { payload, reader, asked, onApply, documents, cardGroups, onMakeCard } = props;
  const address = useMemo(() => parseDoorPayload(payload), [payload]);
  const [attempt, setAttempt] = useState(0);
  const phase = useDoor(address, reader, `${payload} ${String(attempt)}`);
  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);
  if (address === null) return <Notice line={door.damaged} />;
  switch (phase.kind) {
    case 'loading':
      return (
        <main className="shell" aria-busy="true">
          <PageHeader eyebrow={door.eyebrow} title={door.loading} pageTitle={door.pageTitle} />
        </main>
      );
    case 'closed':
      return <Notice line={door.closed} hint={door.closedHint} />;
    case 'offline':
      return <Notice title={door.offlineTitle} line={door.offline} onRetry={retry} />;
    case 'open':
      return (
        <Open
          address={address}
          page={phase.page}
          asked={asked(payload)}
          onApply={onApply}
          documents={documents}
          cardGroups={cardGroups}
          onMakeCard={onMakeCard}
        />
      );
  }
}
