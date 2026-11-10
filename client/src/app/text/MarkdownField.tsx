import { type Key, type ReactNode, useId, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Label,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  TextArea,
  TextField,
} from 'react-aria-components';

import { messages } from '../messages';
import { FieldErrorLine } from '../ui';

/** Props for {@link MarkdownField}. */
export interface MarkdownFieldProps {
  /** The form field's name. */
  readonly name: string;
  /** The visible label. */
  readonly label: string;
  /** A line under the label that says what the field is for. */
  readonly hint: string;
  /** The text, as typed. */
  readonly value: string;
  /** Hears each change to the text. */
  readonly onChange: (value: string) => void;
  /** The error for a value, or null when it's fine. */
  readonly validate: (value: string) => string | null;
  /** Whether the field must be filled in. */
  readonly isRequired?: boolean;
  /** What Preview shows for a value, or null when there's nothing to show yet. */
  readonly preview: (value: string) => ReactNode;
}

type Mode = 'write' | 'preview';

/**
 * A Markdown text field: a plain textarea under a Write tab, and a Preview tab
 * showing how the text will read (ADR-0073: no editor library, no toolbar).
 *
 * The textarea stays mounted, though inert, while Preview shows, so the form
 * always holds the text. If the form is sent from Preview with the text
 * invalid, the field goes back to Write before React Aria focuses the textarea
 * and ties the error to it. The error has a line kept open for it
 * ({@link FieldErrorLine}), so it never moves the submit button on blur.
 */
export function MarkdownField({
  label,
  hint,
  preview,
  validate,
  isRequired = false,
  ...field
}: MarkdownFieldProps) {
  const [mode, setMode] = useState<Mode>('write');
  const syntax = useId();
  const choose = (key: Key) => {
    setMode(key === 'preview' ? 'preview' : 'write');
  };
  // Synchronous, so the Write panel is no longer inert when React Aria then focuses the field.
  const showWrite = () => {
    flushSync(() => {
      setMode('write');
    });
  };
  const shown = mode === 'preview' ? preview(field.value) : null;
  return (
    <TextField
      className="field markdown-field"
      {...field}
      validate={validate}
      isRequired={isRequired}
      aria-describedby={syntax}
    >
      <Label className="field-label">{label}</Label>
      <Text slot="description" className="field-hint">
        {hint}
      </Text>
      <Tabs className="markdown-tabs" selectedKey={mode} onSelectionChange={choose}>
        <TabList className="tab-list" aria-label={messages.markdown.modes}>
          <Tab id="write" className="tab">
            {messages.markdown.write}
          </Tab>
          <Tab id="preview" className="tab">
            {messages.markdown.preview}
          </Tab>
        </TabList>
        <TabPanel id="write" className="tab-panel" shouldForceMount>
          <TextArea className="input input-document" onInvalid={showWrite} />
          <p id={syntax} className="field-hint markdown-hint">
            {messages.markdown.hint}
          </p>
        </TabPanel>
        <TabPanel id="preview" className="tab-panel markdown-preview">
          {shown ?? <p className="muted">{messages.markdown.previewEmpty}</p>}
        </TabPanel>
      </Tabs>
      <FieldErrorLine />
    </TextField>
  );
}
