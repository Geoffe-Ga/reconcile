/**
 * The field that opens a pasted link (#423; ADR-0077 §6), shared by Start and
 * Discover. It is only the field: what the text is and how it opens come from
 * `readLink` (linkKind.ts), so anything else that takes a link reads it the
 * same way. Anything the screen doesn't read gets its one line, which never
 * repeats the text. The app reads the clipboard only through this paste.
 */
import { type SyntheticEvent, useId } from 'react';
import { Button, Form } from 'react-aria-components';

import { type LinkOpeners, readLink } from './linkKind';
import { Field } from './ui';

/** The words a screen gives its field. */
export interface OpenLinkWords {
  readonly heading: string;
  readonly label: string;
  readonly hint: string;
  readonly button: string;
  /** The line for anything the screen does not read. */
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

/** A heading, a field to paste a link into, and the button that opens it. */
export function OpenLink(props: OpenLinkProps) {
  const { words, name, primary = false } = props;
  const heading = useId();
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get(name);
    readLink(typeof value === 'string' ? value : '', props)?.open();
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
          validate={(text) => (readLink(text, props) === null ? words.badLink : null)}
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
