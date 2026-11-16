import { type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { Button, Form } from 'react-aria-components';

import type { CreateGroupValues } from '../app/actions';
import { isHttpLink } from '../app/links';
import { messages } from '../app/messages';
import { sectionsCheck, sectionsPreview } from '../app/sectionsPreview';
import { MarkdownField } from '../app/text/MarkdownField';
import { BackLink, Field, PageHeader } from '../app/ui';
import { DOCUMENT_TITLE_MAX } from '../engine/documents';
import { nfcLength } from '../engine/text';

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
const checkText = sectionsCheck(messages.create.documentTextMissing);

/** A Document's title: not blank, and as long as the fold takes (#92). */
function checkTitle(value: string): string | null {
  const title = value.trim();
  if (title === '') return messages.create.documentTitleMissing;
  return nfcLength(title) > DOCUMENT_TITLE_MAX
    ? messages.create.documentTitleTooLong(DOCUMENT_TITLE_MAX)
    : null;
}

function checkChat(value: string): string | null {
  const link = value.trim();
  return link === '' || isHttpLink(link) ? null : messages.create.chatInvalid;
}

/** One Document block as typed (#92): its key, which names its fields, its title and its text. */
interface Block {
  readonly key: number;
  readonly title: string;
  readonly text: string;
}

/** The form's own fields, read from it: the Documents come from the blocks. */
function readNames(form: HTMLFormElement) {
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
  };
}

const encoder = new TextEncoder();

/** The block whose text is longest in UTF-8: the one to shorten when the genesis is too large. */
function longest(blocks: readonly Block[]): Block | undefined {
  const size = (block: Block) => encoder.encode(block.text).length;
  return blocks.reduce<Block | undefined>(
    (most, block) => (most === undefined || size(block) > size(most) ? block : most),
    undefined,
  );
}

/**
 * Why the genesis was refused as too large, tied to the text field to
 * shorten: the one Document's, or the longest when there are several (#92).
 */
function tooLarge(blocks: readonly Block[]): Record<string, string> {
  const target = longest(blocks);
  const { create } = messages;
  if (target === undefined) return {};
  const reason = blocks.length > 1 ? create.tooLargeTogether : create.tooLarge;
  return { [`text-${String(target.key)}`]: reason };
}

/** The Document blocks, and adding, changing and removing one. A new block starts blank. */
function useBlocks() {
  const next = useRef(1);
  const [blocks, setBlocks] = useState<readonly Block[]>([
    { key: 0, title: messages.create.defaultTitle, text: '' },
  ]);
  const add = (): number => {
    const key = next.current;
    next.current += 1;
    setBlocks((current) => [...current, { key, title: '', text: '' }]);
    return key;
  };
  const change = (key: number, edit: Partial<Omit<Block, 'key'>>) => {
    setBlocks((current) =>
      current.map((block) => (block.key === key ? { ...block, ...edit } : block)),
    );
  };
  const remove = (key: number) => {
    setBlocks((current) => current.filter((block) => block.key !== key));
  };
  return { blocks, add, change, remove };
}

interface DocumentBlockProps {
  readonly block: Block;
  /** Its place among the blocks, from 1, which its heading and Remove name. */
  readonly number: number;
  readonly onChange: (edit: Partial<Omit<Block, 'key'>>) => void;
  /** Removes it; none for the first block, since every group founds a Document. */
  readonly onRemove: (() => void) | null;
}

/**
 * One Document's block (#92): "Document N", its title and its first draft in
 * Write and Preview tabs, split into sections at blank lines, and Remove for
 * every block but the first.
 */
function DocumentBlock({ block, number, onChange, onRemove }: DocumentBlockProps) {
  const { create } = messages;
  const key = String(block.key);
  return (
    <fieldset className="document-block">
      <legend className="eyebrow">{create.documentBlock(number)}</legend>
      <Field
        name={`title-${key}`}
        label={create.documentTitle}
        hint={create.documentTitleHint}
        autoComplete="off"
        isRequired
        validate={checkTitle}
        value={block.title}
        onChange={(title) => {
          onChange({ title });
        }}
      />
      <MarkdownField
        name={`text-${key}`}
        label={create.documentText}
        hint={create.documentTextHint}
        value={block.text}
        onChange={(text) => {
          onChange({ text });
        }}
        isRequired
        validate={checkText}
        preview={sectionsPreview}
      />
      {onRemove === null ? null : (
        <div className="row">
          <Button
            className="button button-quiet"
            aria-label={create.removeDocumentLabel(number)}
            onPress={onRemove}
          >
            {create.removeDocument}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

/** Where the focus goes once the blocks change: a new block's title, or Add another Document. */
type FocusTarget = number | 'add' | null;

/**
 * Create group (`#/create`): the group's name, your name, an optional chat
 * link, and the first draft of each of its Documents (#92), one block each:
 * the first titled 'Mission statement' to start, more by Add another
 * Document, and every block but the first with Remove. Each splits into
 * sections at blank lines, and Preview shows each section as it will read
 * (spec §8). The fit check counts the whole genesis, every Document in it.
 */
export function CreateGroup({ onCreate }: CreateGroupProps) {
  const busy = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const adder = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  const [refused, setRefused] = useState<Record<string, string>>({});
  // Where the focus goes once the blocks change, read by the effect after that render.
  const focusNext = useRef<FocusTarget>(null);
  const { blocks, add, change, remove } = useBlocks();

  // Adding a block takes the focus to its title; removing one, to Add another Document.
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === 'add') adder.current?.focus();
    else
      form.current
        ?.querySelector<HTMLInputElement>(`input[name="title-${String(target)}"]`)
        ?.focus();
  }, [blocks]);

  const create = async (element: HTMLFormElement) => {
    if (busy.current) return;
    busy.current = true;
    setFailed(false);
    setRefused({});
    const documents = blocks.map(({ title, text }) => ({ title: title.trim(), text }));
    const outcome = await onCreate({ ...readNames(element), documents }).catch(
      () => 'failed' as const,
    );
    busy.current = false;
    if (outcome === 'too-large') setRefused(tooLarge(blocks));
    if (outcome === 'failed') setFailed(true);
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void create(event.currentTarget);
  };

  const { create: words } = messages;
  return (
    <main className="shell" data-scene="sky">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader eyebrow={words.eyebrow} title={words.title} pageTitle={words.pageTitle} />
      <p className="lede">{words.lede}</p>
      <Form ref={form} className="form" onSubmit={submit} validationErrors={refused}>
        <Field
          name="groupName"
          label={words.groupName}
          autoComplete="off"
          isRequired
          validate={checkGroupName}
        />
        <Field
          name="yourName"
          label={words.yourName}
          hint={words.yourNameHint}
          autoComplete="off"
          isRequired
          validate={checkYourName}
        />
        <Field
          name="chat"
          label={words.chat}
          hint={words.chatHint}
          inputMode="url"
          autoComplete="off"
          validate={checkChat}
        />
        {blocks.map((block, index) => (
          <DocumentBlock
            key={block.key}
            block={block}
            number={index + 1}
            onChange={(edit) => {
              change(block.key, edit);
            }}
            onRemove={
              index === 0
                ? null
                : () => {
                    focusNext.current = 'add';
                    remove(block.key);
                  }
            }
          />
        ))}
        <div className="row">
          <Button
            ref={adder}
            className="button button-secondary"
            onPress={() => {
              focusNext.current = add();
            }}
          >
            {words.addDocument}
          </Button>
        </div>
        <p className="caption">{words.visibility(blocks.length)}</p>
        {failed ? (
          <p role="alert" className="form-error">
            {words.failed}
          </p>
        ) : null}
        <Button type="submit" className="button button-primary">
          {words.submit}
        </Button>
      </Form>
    </main>
  );
}
