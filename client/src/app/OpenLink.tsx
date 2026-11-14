/**
 * The field that opens a pasted link (#423; ADR-0077 §6), shared by Start and
 * Discover so both read a link the same way: an invite (spec §3), a reconcile
 * card (#114), a coalition's follow link (#124) and, where the screen opens
 * one, a group's front door (#121). Each kind goes to its own handler, which
 * holds a seed in memory, never in the address bar, and opens its page.
 * Anything none of them reads gets the screen's one line, which never repeats
 * the text. The app reads the clipboard only through this paste.
 */
import { type SyntheticEvent, useId } from 'react';
import { Button, Form } from 'react-aria-components';

import { parseCardLink } from '../coalition/card';
import { parseFollowLink } from '../coalition/follow';
import { base64url } from '../crypto/base64url';
import { parseDoorLink } from '../door/page';
import { parseInviteLink } from './invite';
import { Field } from './ui';

/** What opens each kind of link: an invite always; the others where the screen was given a way. */
export interface LinkOpeners {
  /** Opens a pasted invite's seed. It travels in memory, never through the address bar. */
  readonly onOpenInvite: (seed: Uint8Array) => void;
  /** Opens a pasted reconcile card's seed (#114), in memory likewise. */
  readonly onOpenCard?: ((seed: Uint8Array) => void) | undefined;
  /** Opens a pasted follow link's seed (#124), in memory likewise. */
  readonly onOpenFollow?: ((seed: Uint8Array) => void) | undefined;
  /** Opens a pasted front door link's page (#121), by the address after `#door/`. */
  readonly onOpenDoor?: ((payload: string) => void) | undefined;
}

/** The words a screen gives its field. */
export interface OpenLinkWords {
  readonly heading: string;
  readonly label: string;
  readonly hint: string;
  readonly button: string;
  /** The line for anything none of the field's readers reads. */
  readonly badLink: string;
}

/** Props for {@link OpenLink}. */
export interface OpenLinkProps extends LinkOpeners {
  readonly words: OpenLinkWords;
  /** The field's form name, which Start's existing paste keeps. */
  readonly name: string;
  /** True on a screen whose one primary action this is (Discover); Start's is Create group. */
  readonly primary?: boolean;
}

/**
 * Opens whatever link `text` is, each kind by its own handler; a handler the
 * screen wasn't given leaves its link unopened.
 */
function openPasted(text: string, open: LinkOpeners): void {
  const invite = parseInviteLink(text);
  if (invite !== null) open.onOpenInvite(invite);
  const card = parseCardLink(text);
  if (card !== null) open.onOpenCard?.(card);
  const follow = parseFollowLink(text);
  if (follow !== null) open.onOpenFollow?.(follow);
  const door = open.onOpenDoor === undefined ? null : parseDoorLink(text);
  if (door !== null) open.onOpenDoor?.(base64url(door));
}

/** Whether the field reads `text`: an invite, card or follow link, or a door where it opens one. */
function reads(text: string, open: LinkOpeners): boolean {
  const readers = [parseInviteLink, parseCardLink, parseFollowLink];
  if (readers.some((read) => read(text) !== null)) return true;
  return open.onOpenDoor !== undefined && parseDoorLink(text) !== null;
}

/** A heading, a field to paste a link into, and the button that opens it. */
export function OpenLink(props: OpenLinkProps) {
  const { words, name, primary = false } = props;
  const heading = useId();
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get(name);
    openPasted(typeof value === 'string' ? value : '', props);
  };
  return (
    <section className="stack" aria-labelledby={heading}>
      <h2 id={heading} className="heading-3">
        {words.heading}
      </h2>
      <Form className="form" onSubmit={submit}>
        <Field
          name={name}
          label={words.label}
          hint={words.hint}
          autoComplete="off"
          isRequired
          validate={(text) => (reads(text, props) ? null : words.badLink)}
        />
        <Button
          type="submit"
          className={primary ? 'button button-primary' : 'button button-secondary'}
        >
          {words.button}
        </Button>
      </Form>
    </section>
  );
}
