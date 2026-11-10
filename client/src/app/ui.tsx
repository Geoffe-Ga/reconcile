/**
 * Small building blocks the screens share, on React Aria Components (ADR-0022)
 * and styled from DESIGN.md tokens in src/styles/app.css.
 */
import { type InputEvent as ReactInputEvent, useEffect, useRef } from 'react';
import {
  FieldError,
  Input,
  Label,
  Link,
  Text,
  TextArea,
  TextField,
  type TextFieldProps,
} from 'react-aria-components';

import { messages } from './messages';
import { type Route, routeHref } from './router';

/** Props for {@link PageHeader}. */
export interface PageHeaderProps {
  /** A short label above the title, set in caps. */
  readonly eyebrow?: string;
  /** The screen's heading, which may be a group's own words. */
  readonly title: string;
  /** The browser tab's title. Never a group's words: browser history keeps it. */
  readonly pageTitle: string;
}

/**
 * The screen's one `h1`, with an optional eyebrow.
 *
 * It names the tab and takes focus when it appears, so a screen reader
 * announces each new screen of this single-page app.
 */
export function PageHeader({ eyebrow, title, pageTitle }: PageHeaderProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = messages.app.pageTitle(pageTitle);
  }, [pageTitle]);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <header className="page-head">
      {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
      <h1 ref={heading} tabIndex={-1}>
        <bdi>{title}</bdi>
      </h1>
    </header>
  );
}

/** Props for {@link BackLink}. */
export interface BackLinkProps {
  /** Where it goes. */
  readonly to: Route;
  /** What it says, which may be a group's name. */
  readonly label: string;
}

/** A quiet link back up the app, with a leading arrow. */
export function BackLink({ to, label }: BackLinkProps) {
  return (
    <Link className="back-link" href={routeHref(to)}>
      <span aria-hidden="true">{messages.app.back}</span>
      <bdi>{label}</bdi>
    </Link>
  );
}

/** Props for {@link Field}. */
export interface FieldProps extends Omit<TextFieldProps, 'children' | 'className'> {
  /** The visible label. */
  readonly label: string;
  /** A line under the label that says what the field is for. */
  readonly hint?: string;
  /** A text area instead of a one-line input. */
  readonly multiline?: boolean;
  /** Extra classes for the input, such as `input-document`. */
  readonly inputClassName?: string;
}

/**
 * Re-checks a field on each keystroke while it shows an error, so the error
 * updates as the person types and is gone once the text is right.
 *
 * React Aria's native validation changes a shown error only on the input's
 * `change` event, which for text fires on blur. Pressing submit straight
 * after a fix would blur the field on mousedown and remove the error line,
 * moving the button out from under the pointer, so the click would miss. A
 * field that isn't showing an error is left alone: errors still first appear
 * on blur or submit, never in the middle of a word.
 */
function recheckShownError(event: ReactInputEvent<HTMLInputElement | HTMLTextAreaElement>): void {
  const input = event.currentTarget;
  // A `change` that doesn't bubble reaches only React Aria's listener on the input.
  if (input.getAttribute('aria-invalid') === 'true') input.dispatchEvent(new Event('change'));
}

/**
 * A labelled text field: label, hint, input, then its error.
 *
 * React Aria ties the hint and the error to the input with
 * `aria-describedby`, and marks the input invalid when validation fails.
 * A shown error clears as soon as the person fixes the text (see
 * {@link recheckShownError}).
 */
export function Field({ label, hint, multiline = false, inputClassName, ...props }: FieldProps) {
  const inputClass = inputClassName === undefined ? 'input' : `input ${inputClassName}`;
  return (
    <TextField className="field" {...props}>
      <Label className="field-label">{label}</Label>
      {hint === undefined ? null : (
        <Text slot="description" className="field-hint">
          {hint}
        </Text>
      )}
      {multiline ? (
        <TextArea className={inputClass} onInput={recheckShownError} />
      ) : (
        <Input className={inputClass} onInput={recheckShownError} />
      )}
      <FieldError className="field-error" />
    </TextField>
  );
}
