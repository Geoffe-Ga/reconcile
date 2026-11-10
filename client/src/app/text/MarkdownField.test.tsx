/**
 * `<MarkdownField>` (#70): a plain textarea with Write and Preview tabs
 * (ADR-0073: no CodeMirror, no toolbar), shared by the composer and Create group.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button, Form } from 'react-aria-components';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../test/axe';
import { normalizeAtomText } from '../../engine/atomText';
import { AtomText } from './AtomText';
import { MarkdownField } from './MarkdownField';

const HINT =
  '**bold**, *italic*, # heading, - list, [link](https://…). End a line with \\ for a line break.';

const blank = (value: string) => (value.trim() === '' ? 'Write something.' : null);

function preview(value: string) {
  const text = normalizeAtomText(value);
  return text === '' ? null : <AtomText text={text} />;
}

function Harness({ initial = '', onSubmit }: { initial?: string; onSubmit?: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <main>
      <h1>Compose</h1>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.();
        }}
      >
        <MarkdownField
          name="text"
          label="New text"
          hint="If your group passes it, this replaces the section."
          value={value}
          onChange={setValue}
          validate={blank}
          isRequired
          preview={preview}
        />
        <Button type="submit">Send</Button>
      </Form>
    </main>
  );
}

function setup(initial?: string) {
  document.title = 'Compose · Reconcile';
  const onSubmit = vi.fn();
  render(<Harness initial={initial ?? ''} onSubmit={onSubmit} />);
  return { user: userEvent.setup(), onSubmit };
}

const box = () => screen.getByRole('textbox', { name: 'New text' });
const tab = (name: string) => screen.getByRole('tab', { name });

describe('MarkdownField', () => {
  it('opens on Write: a labelled textarea, its hint and the Markdown hint line', async () => {
    setup('Quiet after ten.\n');
    expect(screen.getByRole('tablist', { name: 'Write or preview' })).toBeVisible();
    expect(tab('Write')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Preview')).toHaveAttribute('aria-selected', 'false');
    expect(box().tagName).toBe('TEXTAREA');
    expect(box()).toHaveValue('Quiet after ten.\n');
    expect(box()).toHaveClass('input-document');
    expect(box()).toBeRequired();
    expect(box()).toHaveAccessibleDescription(
      `If your group passes it, this replaces the section. ${HINT}`,
    );
    expect(screen.getByText(HINT)).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('previews the text as it will read, keeping the textarea in the form', async () => {
    const { user } = setup('Quiet after **ten**.\n');
    await user.click(tab('Preview'));
    expect(tab('Preview')).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: 'Preview' });
    expect(within(panel).getByText('ten', { selector: 'strong' })).toBeVisible();
    // The Write panel stays mounted but inert, so the form still holds the text.
    const textarea = document.querySelector('textarea');
    expect(textarea).toHaveValue('Quiet after **ten**.\n');
    expect(textarea?.closest('.tab-panel')).toHaveAttribute('inert');
    expect(textarea?.closest('.tab-panel')).toHaveAttribute('data-inert', 'true');
    expect(await axeViolations()).toEqual([]);
  });

  it('previews what is typed, as typed', async () => {
    const { user } = setup();
    await user.click(box());
    await user.paste('# Rules');
    await user.click(tab('Preview'));
    expect(screen.getByRole('heading', { level: 2, name: 'Rules' })).toBeVisible();
    await user.click(tab('Write'));
    expect(box()).toHaveValue('# Rules');
  });

  it('says so when there is nothing to preview', async () => {
    const { user } = setup(' \n');
    await user.click(tab('Preview'));
    expect(screen.getByRole('tabpanel', { name: 'Preview' })).toHaveTextContent(
      'Nothing to preview yet.',
    );
  });

  it('goes back to Write, with the error tied to the field, when the form is sent from Preview', async () => {
    const { user, onSubmit } = setup();
    await user.click(tab('Preview'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(tab('Write')).toHaveAttribute('aria-selected', 'true');
    expect(box().closest('[role="tabpanel"]')).not.toHaveAttribute('inert');
    expect(box()).toHaveFocus();
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    expect(box()).toHaveAccessibleDescription(
      `If your group passes it, this replaces the section. Write something. ${HINT}`,
    );
  });

  it('keeps its error’s line, so an error shown or cleared on blur moves nothing (#165)', async () => {
    const { user } = setup('Fine.\n');
    // jsdom has no layout, so the line app.css holds open is found by its class.
    const line = box().closest('.field')?.querySelector('.field-error-line');
    expect(line).toBeEmptyDOMElement();

    await user.clear(box());
    await user.tab();
    expect(line).toHaveTextContent('Write something.');
    expect(box()).toHaveAttribute('aria-invalid', 'true');

    await user.click(box());
    await user.paste('Fine again.');
    await user.tab();
    expect(line).toBeEmptyDOMElement();
    expect(box()).not.toHaveAttribute('aria-invalid');
  });

  it('sends the form from Preview when the text is fine', async () => {
    const { user, onSubmit } = setup('Fine.\n');
    await user.click(tab('Preview'));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
