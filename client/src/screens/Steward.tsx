/**
 * The steward's console (`#/steward`; #488, #489; docs/spec/listed-doors.md
 * §6.4).
 *
 * It exists only on a device that holds the steward's key, and lists:
 *
 * - the listings waiting for release, each with the one thing a reader will
 *   see of it (its name, and whether it accepted this app's covenant) and,
 *   when a live listing holds a name like it, that listing beside it, since
 *   a release would put it behind that one, unseen (rule 4), with Release;
 * - the holds that stand, what each hides and when it lapses, with Uphold
 *   for an entry and Suspend for a listing (#489);
 * - what stands on the shelf: each listing, with Hold and Suspend, and each
 *   entry under it, with Hold and Uphold (#489);
 * - the pause, with Pause the shelf or Lift the pause (#489).
 *
 * Every action that names a clause asks which, and each says what readers,
 * and the group, will see once it is sent. Reports, appeals and flagged
 * entries wait for later issues (§6.3, §6.6).
 */
import { useState } from 'react';
import { Button, Label, RadioButton, RadioField, RadioGroup } from 'react-aria-components';

import { holdPresses } from '../app/holdPresses';
import { messages } from '../app/messages';
import { formatDate } from '../app/time';
import { BackLink, PageHeader, Section } from '../app/ui';
import { CLAUSE_WORDS, COVENANT_HASH } from '../shelf/covenant';
import type { ShelfEntry, ShelfListing, StandingHold, WaitingListing } from '../shelf/fold';
import type { Clause, NoticeBody } from '../shelf/record';

/** What the console shows (§6.4): what waits, what stands, what's held, and the pause. */
export interface StewardView {
  /** The listings waiting for release, each beside any live look-alike. */
  readonly waiting: readonly WaitingListing[];
  /** The listings readers see now, which the steward may hold or suspend. */
  readonly listings: readonly ShelfListing[];
  /** The entries that stand, a day's wait or not, which the steward may hold or uphold. */
  readonly entries: readonly ShelfEntry[];
  /** The holds that stand, with what each hides and when it lapses. */
  readonly holds: readonly StandingHold[];
  /** Whether the steward's pause stands. */
  readonly paused: boolean;
}

/** What the console shows (`app/steward.ts`), or why it has nothing to show. */
export type StewardQueue = StewardView | 'unavailable' | 'failed';

/** Props for {@link Steward}. */
export interface StewardProps {
  /** What the console lists, or that the shelf is off or couldn't be read. */
  readonly queue: StewardQueue;
  /** Signs and PUTs `notice`; true once the relay has it. */
  readonly onNotice: (notice: NoticeBody) => Promise<boolean>;
}

/** Where one action stands. */
type Sending = 'idle' | 'busy' | 'sent' | 'failed';

/** The acts that name a clause. */
type ClauseAct = 'hold' | 'uphold' | 'suspend';

const words = messages.shelfSteward;
const CLAUSES: readonly Clause[] = ['C1', 'C2', 'C3'];

/** The steward's notice of `act` on `address`, or its entry `id`, under `clause`. */
function noticeOf(act: ClauseAct, address: string, id: string | null, clause: Clause): NoticeBody {
  if (act === 'uphold') return { v: 1, kind: 'notice', act, address, id: id ?? '', clause };
  if (act === 'suspend') return { v: 1, kind: 'notice', act, address, clause };
  return { v: 1, kind: 'notice', act, address, ...(id === null ? {} : { id }), clause };
}

/** What readers will see once `act` is sent, under `clause` in words. */
function willSee(act: ClauseAct, entry: boolean, clause: string): string {
  if (act === 'uphold') return words.willSeeUphold(clause);
  if (act === 'suspend') return words.willSeeSuspend(clause);
  return entry ? words.willSeeHoldEntry(clause) : words.willSeeHoldListing(clause);
}

/** Props for {@link SendButton}. */
interface SendButtonProps {
  readonly label: string;
  readonly busyLabel: string;
  readonly send: () => Promise<boolean>;
  readonly sentLine?: string;
  readonly failedLine?: string;
}

/** One notice's button, which sends it once and then says it was sent, or that it failed. */
function SendButton({ label, busyLabel, send, sentLine, failedLine }: SendButtonProps) {
  const [state, setState] = useState<Sending>('idle');
  const busy = state === 'busy';
  const press = () => {
    setState('busy');
    void send()
      .catch(() => false)
      .then((done) => {
        setState(done ? 'sent' : 'failed');
      });
  };
  return (
    <>
      {state === 'sent' ? null : (
        <div onPointerDownCapture={holdPresses(busy)}>
          <Button className="button button-primary" isDisabled={busy} onPress={press}>
            {busy ? busyLabel : label}
          </Button>
        </div>
      )}
      <p className="status" role="status">
        {state === 'sent' ? (sentLine ?? words.sent) : null}
        {state === 'failed' ? (failedLine ?? words.sendFailed) : null}
      </p>
    </>
  );
}

/** Which clause an action names, each in its words. */
function ClausePicker(props: {
  readonly value: Clause;
  readonly onChange: (clause: Clause) => void;
}) {
  return (
    <RadioGroup
      className="level-group"
      value={props.value}
      onChange={(value) => {
        const clause = CLAUSES.find((c) => c === value);
        if (clause !== undefined) props.onChange(clause);
      }}
    >
      <Label className="field-label">{words.clauseLabel}</Label>
      <div className="level-options">
        {CLAUSES.map((clause) => (
          <RadioField key={clause} value={clause} className="level-option">
            <RadioButton className="level-button">
              {words.clauseOption(clause, CLAUSE_WORDS[clause])}
            </RadioButton>
          </RadioField>
        ))}
      </div>
    </RadioGroup>
  );
}

/** The labels of the acts that name a clause. */
const ACT_LABELS: Readonly<Record<ClauseAct, string>> = {
  hold: words.hold,
  uphold: words.uphold,
  suspend: words.suspend,
};

/**
 * The actions on one listing or entry: a clause, then each act, each saying
 * what readers will see under that clause before it is sent.
 */
function Actions(props: {
  readonly address: string;
  readonly id: string | null;
  readonly acts: readonly ClauseAct[];
  readonly clause?: Clause;
  readonly onNotice: StewardProps['onNotice'];
}) {
  const { address, id, acts, onNotice } = props;
  const [clause, setClause] = useState<Clause>(props.clause ?? 'C1');
  return (
    <div className="stack">
      <ClausePicker value={clause} onChange={setClause} />
      {acts.map((act) => (
        <div key={act} className="stack">
          <p className="caption">{willSee(act, id !== null, CLAUSE_WORDS[clause])}</p>
          <SendButton
            label={ACT_LABELS[act]}
            busyLabel={words.sending}
            send={() => onNotice(noticeOf(act, address, id, clause))}
          />
        </div>
      ))}
    </div>
  );
}

/** One waiting listing: what readers will see, any look-alike, and Release. */
function WaitingCard(props: {
  readonly waiting: WaitingListing;
  readonly onNotice: StewardProps['onNotice'];
}) {
  const { listing, holder } = props.waiting;
  const { address } = listing;
  return (
    <li className="card stack steward-waiting">
      <h3 className="heading-3">
        <bdi>{listing.name}</bdi>
      </h3>
      <p className="meta">
        {listing.covenant === COVENANT_HASH ? words.covenantCurrent : words.covenantOther}
      </p>
      <p className="meta">{words.waitingSince(formatDate(listing.received))}</p>
      {holder === null ? null : (
        <div className="notice">
          <p>
            {words.lookalike} <bdi>{holder.name}</bdi>
          </p>
          <p>{words.lookalikeHint}</p>
        </div>
      )}
      <p className="caption">{words.willSee(listing.name)}</p>
      <SendButton
        label={words.release}
        busyLabel={words.releasing}
        sentLine={words.released}
        failedLine={words.releaseFailed}
        send={() => props.onNotice({ v: 1, kind: 'notice', act: 'release', address })}
      />
    </li>
  );
}

/** What one hold hides: a listing by name, an entry by title, or a record this device hasn't read. */
function heldWhat({ hold, name, title }: StandingHold): string {
  if (hold.id !== null && title !== null) return words.heldEntry(title);
  if (hold.id === null && name !== null) return words.heldListing(name);
  return words.heldUnknown;
}

/** One standing hold: what it hides, its clause, when it lapses, and Uphold or Suspend. */
function HoldCard(props: {
  readonly held: StandingHold;
  readonly onNotice: StewardProps['onNotice'];
}) {
  const { hold } = props.held;
  return (
    <li className="card stack">
      <h3 className="heading-3">
        <bdi>{heldWhat(props.held)}</bdi>
      </h3>
      <p className="meta">{words.heldFor(CLAUSE_WORDS[hold.clause], formatDate(hold.until))}</p>
      <Actions
        address={hold.address}
        id={hold.id}
        acts={hold.id === null ? ['suspend'] : ['uphold']}
        clause={hold.clause}
        onNotice={props.onNotice}
      />
    </li>
  );
}

/** One listing that stands, with Hold and Suspend, then each of its entries with Hold and Uphold. */
function ListingCard(props: {
  readonly listing: ShelfListing;
  readonly entries: readonly ShelfEntry[];
  readonly onNotice: StewardProps['onNotice'];
}) {
  const { listing, onNotice } = props;
  return (
    <li className="card stack">
      <h3 className="heading-3">
        <bdi>{listing.name}</bdi>
      </h3>
      <Actions address={listing.address} id={null} acts={['hold', 'suspend']} onNotice={onNotice} />
      {props.entries.length === 0 ? null : (
        <ul className="stack">
          {props.entries.map((entry) => (
            <li key={entry.id} className="stack">
              <h4 className="heading-3">
                <bdi>{entry.title}</bdi>
              </h4>
              {entry.text === '' ? null : (
                <p className="dispatch-text" dir="auto">
                  {entry.text}
                </p>
              )}
              <Actions
                address={entry.address}
                id={entry.id}
                acts={['hold', 'uphold']}
                onNotice={onNotice}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The pause: whether it stands, and the one notice that changes it, with what readers will see. */
function Pause(props: { readonly paused: boolean; readonly onNotice: StewardProps['onNotice'] }) {
  const { paused } = props;
  return (
    <div className="stack">
      <p>{paused ? words.pausedNow : words.showingNow}</p>
      <p className="caption">
        {paused ? words.willSeeResume : words.willSeePause(messages.discover.paused)}
      </p>
      <SendButton
        label={paused ? words.resume : words.pause}
        busyLabel={words.sending}
        send={() => props.onNotice({ v: 1, kind: 'notice', act: 'pause', on: !paused })}
      />
    </div>
  );
}

/** The waiting listings, or one line saying there are none. */
function Waiting({ view, onNotice }: StewardSectionProps) {
  if (view.waiting.length === 0) return <p className="lede">{words.none}</p>;
  return (
    <ul className="stack steward-queue">
      {view.waiting.map((waiting) => (
        <WaitingCard key={waiting.listing.address} waiting={waiting} onNotice={onNotice} />
      ))}
    </ul>
  );
}

/** The standing holds, or one line saying there are none. */
function Holds({ view, onNotice }: StewardSectionProps) {
  if (view.holds.length === 0) return <p>{words.noHolds}</p>;
  return (
    <ul className="stack">
      {view.holds.map((held) => (
        <HoldCard
          key={`${held.hold.address} ${held.hold.id ?? ''}`}
          held={held}
          onNotice={onNotice}
        />
      ))}
    </ul>
  );
}

/** What stands on the shelf, or one line saying nothing does. */
function OnShelf({ view, onNotice }: StewardSectionProps) {
  if (view.listings.length === 0) return <p>{words.emptyShelf}</p>;
  return (
    <ul className="stack">
      {view.listings.map((listing) => (
        <ListingCard
          key={listing.address}
          listing={listing}
          entries={view.entries.filter((entry) => entry.address === listing.address)}
          onNotice={onNotice}
        />
      ))}
    </ul>
  );
}

/** Props for each of the console's sections. */
interface StewardSectionProps {
  readonly view: StewardView;
  readonly onNotice: StewardProps['onNotice'];
}

/** The steward's console: what waits, what's held, what stands, and the pause. */
export function Steward({ queue, onNotice }: StewardProps) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'settings' }} label={messages.settings.title} />
      <PageHeader title={words.title} pageTitle={words.pageTitle} />
      <p className="lede">{words.consoleLede}</p>
      {queue === 'unavailable' ? <p className="lede">{words.unavailable}</p> : null}
      {queue === 'failed' ? <p className="lede">{words.readFailed}</p> : null}
      {typeof queue === 'string' ? null : (
        <div className="sections">
          <Section title={words.waitingHeading}>
            <Waiting view={queue} onNotice={onNotice} />
          </Section>
          <Section title={words.holdsHeading}>
            <Holds view={queue} onNotice={onNotice} />
          </Section>
          <Section title={words.shelfHeading}>
            <OnShelf view={queue} onNotice={onNotice} />
          </Section>
          <Section title={words.pauseHeading}>
            <Pause paused={queue.paused} onNotice={onNotice} />
          </Section>
        </div>
      )}
    </main>
  );
}
