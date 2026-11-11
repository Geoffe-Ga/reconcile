/**
 * Small building blocks the screens share, on React Aria Components (ADR-0022)
 * and styled from DESIGN.md tokens in src/styles/app.css.
 */
import { type ReactNode, useEffect, useId, useRef } from 'react';
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
  /**
   * Whether the heading takes focus when it appears (the default). False where
   * a heading below takes it instead, as Join's Document heading does (#91).
   */
  readonly takesFocus?: boolean;
  /** A line that belongs with the title, under it, such as the Document a Proposal changes (#92). */
  readonly children?: ReactNode;
}

/**
 * The screen's one `h1`, with an optional eyebrow.
 *
 * It names the tab and, unless told otherwise, takes focus when it appears,
 * so a screen reader announces each new screen of this single-page app.
 */
export function PageHeader({
  eyebrow,
  title,
  pageTitle,
  takesFocus = true,
  children,
}: PageHeaderProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = messages.app.pageTitle(pageTitle);
  }, [pageTitle]);
  useEffect(() => {
    if (takesFocus) heading.current?.focus();
  }, [takesFocus]);
  return (
    <header className="page-head">
      {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
      <h1 ref={heading} tabIndex={-1}>
        <bdi>{title}</bdi>
      </h1>
      {children}
    </header>
  );
}

/** Props for {@link Section}. */
export interface SectionProps {
  /** The section's heading, set as an eyebrow. */
  readonly title: string;
  readonly children: ReactNode;
}

/** A labelled section of a screen: a hairline above, its eyebrow heading beside it on wide screens. */
export function Section({ title, children }: SectionProps) {
  const heading = useId();
  return (
    <section className="section" aria-labelledby={heading}>
      <h2 id={heading} className="eyebrow">
        {title}
      </h2>
      {children}
    </section>
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
 * A text field's error, in a line kept open while the field is valid (#165).
 * Use it inside a React Aria `TextField` whose error can come and go.
 *
 * React Aria shows or clears the error when the field loses focus, and
 * pressing a submit button is what takes the focus. If the error's line
 * opened or closed then, the button would move between mousedown and mouseup
 * and the click would miss. The error itself still renders only while the
 * field is invalid, so `aria-describedby` names it only then.
 */
export function FieldErrorLine() {
  return (
    <div className="field-error-line">
      <FieldError className="field-error" />
    </div>
  );
}

/**
 * Whether a field's error can appear or clear as it loses focus: it checks
 * its value, and the person can change that value.
 */
function errorCanChange({
  validate,
  isRequired,
  isReadOnly,
  isDisabled,
}: Pick<TextFieldProps, 'validate' | 'isRequired' | 'isReadOnly' | 'isDisabled'>): boolean {
  const checks = validate !== undefined || isRequired === true;
  return checks && isReadOnly !== true && isDisabled !== true;
}

/**
 * A labelled text field: label, hint, input, then its error.
 *
 * React Aria ties the hint and the error to the input with
 * `aria-describedby`, and marks the input invalid when validation fails. A
 * field whose error can come and go keeps a line open for it
 * ({@link FieldErrorLine}); one that can't, such as a read-only link, doesn't.
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
      {multiline ? <TextArea className={inputClass} /> : <Input className={inputClass} />}
      {errorCanChange(props) ? <FieldErrorLine /> : <FieldError className="field-error" />}
    </TextField>
  );
}
