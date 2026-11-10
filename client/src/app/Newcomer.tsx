/**
 * A newcomer's way to a vote, on screen (#101; ADR-0014, ADR-0021): their
 * progress on the People list, who has vouched for them, and their own line
 * on when their vote arrives. The engine decides who holds rights and when
 * (src/engine/admission.ts), and src/app/admissionLines.ts words it; this
 * file sets it on screen, each name in `<bdi>`.
 */
import { Fragment } from 'react';

import { admissionOf } from '../engine/admission';
import type { GroupState } from '../engine/fold';
import { displayName } from '../engine/names';
import { progressLine, waitingLine } from './admissionLines';
import { messages } from './messages';

/** "Vouched for by Ana and Ben", each name in `<bdi>`, joined as this language joins a list. */
function VouchedBy({
  state,
  vouchers,
}: {
  readonly state: GroupState;
  readonly vouchers: readonly string[];
}) {
  const names = vouchers.map((voucher) => displayName(state, voucher) ?? '');
  const parts = new Intl.ListFormat(messages.app.locale, { type: 'conjunction' }).formatToParts(
    names,
  );
  return (
    <p className="person-vouched">
      {messages.admission.vouchedBy}{' '}
      {parts.map((part, i) =>
        part.type === 'element' ? (
          <bdi key={i}>{part.value}</bdi>
        ) : (
          <Fragment key={i}>{part.value}</Fragment>
        ),
      )}
    </p>
  );
}

/**
 * A newcomer's progress on their row in People, and who has vouched for them;
 * nothing for someone who holds rights. Everyone in the group reads it, as
 * they read ballots (ADR-0010).
 */
export function NewcomerProgress({
  state,
  author,
}: {
  readonly state: GroupState;
  readonly author: string;
}) {
  const admission = admissionOf(state, author);
  if (admission === null) return null;
  return (
    <div className="person-newcomer">
      <p>{progressLine(admission, state.at)}</p>
      {admission.vouchedBy.length === 0 ? null : (
        <VouchedBy state={state} vouchers={admission.vouchedBy} />
      )}
    </div>
  );
}

/** The newcomer's own line, where their screens would offer voting; nothing for anyone else. */
export function WaitingNote({ state, me }: { readonly state: GroupState; readonly me: string }) {
  const line = waitingLine(state, me);
  return line === null ? null : <p className="waiting-note">{line}</p>;
}
