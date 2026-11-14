import { type SyntheticEvent, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import {
  Button,
  Form,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  Text,
} from 'react-aria-components';

import { messages } from '../app/messages';
import type { CardGroup, CardLookup, FoundCard } from '../app/reconcile';
import { replaceRoute } from '../app/router';
import { BackLink, Field, PageHeader } from '../app/ui';
import { type Card, parseCardPayload } from '../coalition/card';

/** Props for {@link BringCard}. */
export interface BringCardProps {
  /** The seed from `#reconcile/{seed}`, as text, or null once it has left the address bar. */
  readonly payload: string | null;
  /** The seed of a card pasted on Start, handed over in memory, for when there's no payload. */
  readonly heldSeed: Uint8Array | null;
  /** Opens the card the seed names, once per card and once per Try again. */
  readonly lookup: (seed: Uint8Array) => Promise<CardLookup>;
  /** Brings the card to one of this device's groups under a coalition name; false when that didn't finish. */
  readonly onBring: (found: FoundCard, groupId: string, yourName: string) => Promise<boolean>;
  /** Not now: drops the card held in memory and goes back to Start, writing nothing. */
  readonly onNotNow: () => void;
}

type Phase = { readonly kind: 'loading' } | CardLookup;

const { bring } = messages;

const checkName = (value: string) => (value.trim() === '' ? bring.yourNameMissing : null);

/** A plain page: the way back, a title, and one line. */
function Plain({ title, line }: { readonly title: string; readonly line: string }) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={title} pageTitle={bring.pageTitle} />
      <p className="lede">{line}</p>
    </main>
  );
}

function Offline({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={bring.offlineTitle} pageTitle={bring.pageTitle} />
      <div className="stack">
        <p className="lede">{bring.offline}</p>
        <div>
          <Button className="button button-primary" onPress={onRetry}>
            {bring.retry}
          </Button>
        </div>
      </div>
    </main>
  );
}

/** Props for {@link CardPreview}. */
export interface CardPreviewProps {
  readonly card: Pick<Card, 'seat' | 'title' | 'atoms'>;
  /** The statement title's heading level: 2 on Bring a card, 4 in Applications' rows (#426). */
  readonly level: 2 | 4;
}

/**
 * The card as plain text: who it's from, then its statement's title and
 * sections. Every word came from another group's device, so none of it is
 * read as Markdown or HTML, and each sits in its own `<bdi>`. Applications
 * shows a card left at the door the same way (#426).
 */
export function CardPreview({ card, level }: CardPreviewProps) {
  const Title = level === 2 ? 'h2' : 'h4';
  return (
    <>
      <p className="invite-from">
        {bring.from} <bdi>{card.seat.name}</bdi>
      </p>
      <div className="invite-document">
        <p className="eyebrow">{bring.statementLabel}</p>
        <Title className="heading-2">
          <bdi>{card.title}</bdi>
        </Title>
        <div className="card-statement">
          {card.atoms.map((atom, index) => (
            // Sections are numbered by position; the same text may appear twice.
            <p key={index} className="card-atom" dir="auto">
              {atom}
            </p>
          ))}
        </div>
      </div>
    </>
  );
}

/** The card as Bring a card shows it: {@link CardPreview} on a card of its own. */
function CardText({ found }: { readonly found: FoundCard }) {
  return (
    <div className="card invite-preview">
      <CardPreview card={found.card} level={2} />
    </div>
  );
}

/** Props for {@link GroupPicker}. */
export interface PickerProps {
  readonly groups: readonly CardGroup[];
  readonly value: string;
  readonly onChange: (groupId: string) => void;
  /** The label and hint, in place of Bring a card's own: Propose reconciling's at a door (#426). */
  readonly words?: { readonly label: string; readonly hint: string };
}

/**
 * One card per group that may take this one, as a radio group, the first
 * chosen to start, and each coalition this person takes part in that may take
 * it (#122), marked as one.
 */
export function GroupPicker({ groups, value, onChange, words }: PickerProps) {
  const both = groups.some((group) => group.kind === 'coalition');
  const own = both
    ? { label: bring.groupOrCoalitionLabel, hint: bring.groupOrCoalitionHint }
    : { label: bring.groupLabel, hint: bring.groupHint };
  const { label, hint } = words ?? own;
  return (
    <RadioGroup className="level-group" value={value} onChange={onChange} isRequired>
      <Label className="field-label">{label}</Label>
      <Text slot="description" className="field-hint">
        {hint}
      </Text>
      <div className="level-options">
        {groups.map((group) => (
          <RadioField key={group.groupId} value={group.groupId} className="level-option">
            <RadioButton className="level-button">
              <bdi>{group.name}</bdi>
            </RadioButton>
            {group.kind === 'coalition' ? (
              <Text slot="description" className="level-description">
                {bring.coalitionOption}
              </Text>
            ) : null}
          </RadioField>
        ))}
      </div>
    </RadioGroup>
  );
}

interface BringFormProps {
  readonly found: FoundCard;
  readonly onBring: BringCardProps['onBring'];
  readonly onNotNow: BringCardProps['onNotNow'];
}

/** Which group, your name in the coalition, Bring and Not now; or why no group can take it. */
function BringFields({ found, onBring, onNotNow }: BringFormProps) {
  const [groupId, setGroupId] = useState(found.groups[0]?.groupId ?? '');
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const question = useId();

  const send = async (name: string) => {
    if (busy.current) return;
    busy.current = true;
    setFailed(false);
    const brought = await onBring(found, groupId, name).catch(() => false);
    busy.current = false;
    if (!brought) setFailed(true);
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name');
    void send(typeof name === 'string' ? name.trim() : '');
  };

  const notNow = (
    <Button
      className="button button-quiet"
      onPress={() => {
        if (!busy.current) onNotNow();
      }}
    >
      {bring.notNow}
    </Button>
  );

  // A coalition this person takes part in may take the card too (#122).
  const offersCoalitions = found.groups.some((group) => group.kind === 'coalition');
  const picked = found.groups.find((group) => group.groupId === groupId);
  return (
    <section className="join-decide stack" aria-labelledby={question}>
      <h2 id={question} className="heading-2">
        {offersCoalitions ? bring.questionBoth : bring.question}
      </h2>
      {found.groups.length === 0 ? (
        <>
          <p>{bring.noGroups}</p>
          <div className="row">{notNow}</div>
        </>
      ) : (
        <Form className="form" onSubmit={submit}>
          <GroupPicker groups={found.groups} value={groupId} onChange={setGroupId} />
          <Field
            name="name"
            label={bring.yourNameLabel}
            hint={bring.yourNameHint}
            autoComplete="off"
            isRequired
            validate={checkName}
          />
          {failed ? (
            <p role="alert" className="form-error">
              {bring.failed}
            </p>
          ) : null}
          <div className="row form-actions">
            <Button type="submit" className="button button-primary">
              {picked?.kind === 'coalition' ? bring.submitCoalition : bring.submit}
            </Button>
            {notNow}
          </div>
        </Form>
      )}
    </section>
  );
}

/** The opened card, then what to bring it to. */
function BringForm({ found, onBring, onNotNow }: BringFormProps) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader eyebrow={bring.eyebrow} title={found.card.name} pageTitle={bring.pageTitle} />
      {found.mode === 'admit' ? <p className="lede">{bring.admitLede}</p> : null}
      <CardText found={found} />
      <BringFields found={found} onBring={onBring} onNotNow={onNotNow} />
    </main>
  );
}

/**
 * Bring a card (`#reconcile/{seed}`; #114): reads the seed, takes it out of
 * the address bar, opens the card and shows it as plain text, then asks which
 * of this device's groups to bring it to, among those where this person can
 * propose and that don't hold it yet, and their name in the coalition. A seed
 * that doesn't parse shows the expired-or-damaged line and fetches nothing;
 * a card whose coalition is forming says it was used. Nothing is stored, and
 * no key made, before Bring; Not now drops the card.
 */
export function BringCard({ payload, heldSeed, lookup, onBring, onNotNow }: BringCardProps) {
  const [source, setSource] = useState(() => ({
    payload,
    seed: payload === null ? heldSeed : parseCardPayload(payload),
  }));
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // A new card can arrive while this shows. The payload going back to null is this screen clearing it.
  if (payload !== null && payload !== source.payload) {
    setSource({ payload, seed: parseCardPayload(payload) });
    setPhase({ kind: 'loading' });
  }
  const { seed } = source;

  useEffect(() => {
    if (payload !== null) replaceRoute({ name: 'card', payload: null });
  }, [payload]);

  const read = useEffectEvent((card: Uint8Array) => lookup(card));

  useEffect(() => {
    if (seed === null) return;
    let live = true;
    read(seed).then(
      (found) => {
        if (live) setPhase(found);
      },
      () => {
        if (live) setPhase({ kind: 'offline' });
      },
    );
    return () => {
      live = false;
    };
  }, [seed, attempt]);

  if (seed === null) return <Plain title={bring.badLinkTitle} line={bring.badLink} />;
  switch (phase.kind) {
    case 'loading':
      return (
        <main className="shell" aria-busy="true">
          <PageHeader title={bring.loading} pageTitle={bring.pageTitle} />
        </main>
      );
    case 'missing':
      return <Plain title={bring.badLinkTitle} line={bring.badLink} />;
    case 'used':
      return <Plain title={bring.usedTitle} line={bring.used} />;
    case 'offline':
      return (
        <Offline
          onRetry={() => {
            setPhase({ kind: 'loading' });
            setAttempt((count) => count + 1);
          }}
        />
      );
    case 'found':
      return <BringForm found={phase.found} onBring={onBring} onNotNow={onNotNow} />;
  }
}
