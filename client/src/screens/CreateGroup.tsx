import { type ReactNode, type SyntheticEvent, useRef, useState } from 'react';
import { Button, Form } from 'react-aria-components';

import type { CreateGroupValues } from '../app/actions';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import { AtomText } from '../app/text/AtomText';
import { MarkdownField } from '../app/text/MarkdownField';
import { BackLink, Field, PageHeader } from '../app/ui';
import { genesisAtoms } from '../engine/atomText';
import { splitAtoms } from '../engine/text';

/** How creating went: `created` moves on to Group home; the others stay on the form. */
export type CreateOutcome = 'created' | 'too-large' | 'failed';

/** Props for {@link CreateGroup}. */
export interface CreateGroupProps {
  /** Makes the group from valid entries. */
  readonly onCreate: (values: CreateGroupValues) => Promise<CreateOutcome>;
}

const filledIn = (missing: string) => (value: string) => (value.trim() === '' ? missing : null);

const checkGroupName = filledIn(messages.create.groupNameMissing);
const checkYourName = filledIn(messages.create.yourNameMissing);
const checkTitle = filledIn(messages.create.documentTitleMissing);

function checkChat(value: string): string | null {
  const link = value.trim();
  return link === '' || isHttpLink(link) ? null : messages.create.chatInvalid;
}

function checkText(value: string): string | null {
  return splitAtoms(value).length === 0 ? messages.create.documentTextMissing : null;
}

/** The Document as its sections will read, split and normalized as genesis will be. */
function preview(value: string): ReactNode {
  const atoms = genesisAtoms(value);
  if (atoms.length === 0) return null;
  return (
    <div className="document">
      {atoms.map((atom, index) => (
        // Sections are numbered by position, as the Document view numbers them.
        <div key={index} className="atom">
          <p className="eyebrow">{messages.create.section(index + 1)}</p>
          <AtomText text={atom} />
        </div>
      ))}
    </div>
  );
}

function readValues(form: HTMLFormElement): CreateGroupValues {
  const data = new FormData(form);
  const read = (name: string): string => {
    const value = data.get(name);
    return typeof value === 'string' ? value : '';
  };
  const chat = read('chat').trim();
  return {
    groupName: read('groupName').trim(),
    yourName: read('yourName').trim(),
    chat: chat === '' ? null : chat,
    title: read('title').trim(),
    text: read('text'),
  };
}

/**
 * Create group (`#/create`): the group's name, your name, an optional chat
 * link, and the first draft of its Document in Write and Preview tabs. It
 * splits into sections at blank lines, and Preview shows each section as it
 * will read (spec §8).
 */
export function CreateGroup({ onCreate }: CreateGroupProps) {
  const busy = useRef(false);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [text, setText] = useState('');

  const create = async (form: HTMLFormElement) => {
    if (busy.current) return;
    busy.current = true;
    setFailed(false);
    setRefused({});
    const outcome = await onCreate(readValues(form)).catch(() => 'failed' as const);
    busy.current = false;
    if (outcome === 'too-large') setRefused({ text: messages.create.tooLarge });
    if (outcome === 'failed') setFailed(true);
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void create(event.currentTarget);
  };

  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader
        eyebrow={messages.create.eyebrow}
        title={messages.create.title}
        pageTitle={messages.create.pageTitle}
      />
      <p className="lede">{messages.create.lede}</p>
      <Form className="form" onSubmit={submit} validationErrors={refused}>
        <Field
          name="groupName"
          label={messages.create.groupName}
          autoComplete="off"
          isRequired
          validate={checkGroupName}
        />
        <Field
          name="yourName"
          label={messages.create.yourName}
          hint={messages.create.yourNameHint}
          autoComplete="off"
          isRequired
          validate={checkYourName}
        />
        <Field
          name="chat"
          label={messages.create.chat}
          hint={messages.create.chatHint}
          inputMode="url"
          autoComplete="off"
          validate={checkChat}
        />
        <Field
          name="title"
          label={messages.create.documentTitle}
          hint={messages.create.documentTitleHint}
          autoComplete="off"
          isRequired
          validate={checkTitle}
        />
        <MarkdownField
          name="text"
          label={messages.create.documentText}
          hint={messages.create.documentTextHint}
          value={text}
          onChange={setText}
          isRequired
          validate={checkText}
          preview={preview}
        />
        <p className="caption">{messages.create.visibility}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {messages.create.failed}
          </p>
        ) : null}
        <Button type="submit" className="button button-primary">
          {messages.create.submit}
        </Button>
      </Form>
    </main>
  );
}
