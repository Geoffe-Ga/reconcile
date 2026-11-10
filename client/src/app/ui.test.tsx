import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, Form } from 'react-aria-components';
import { describe, expect, it } from 'vitest';

import { BackLink, Field, PageHeader } from './ui';

describe('PageHeader', () => {
  it('titles the tab without user content, and takes focus so the change is announced', () => {
    render(<PageHeader eyebrow="Your group" title="Riverside Tenants" pageTitle="Your group" />);
    const heading = screen.getByRole('heading', { level: 1, name: 'Riverside Tenants' });
    expect(heading).toHaveFocus();
    expect(document.title).toBe('Your group · Reconcile');
    expect(screen.getByText('Your group', { selector: 'p' })).toHaveClass('eyebrow');
  });

  it('isolates the title’s direction, as names may be right-to-left', () => {
    render(<PageHeader title="مجموعة" pageTitle="Your group" />);
    expect(screen.getByRole('heading', { level: 1 }).querySelector('bdi')).toHaveTextContent(
      'مجموعة',
    );
  });
});

describe('BackLink', () => {
  it('links to a route, with the arrow hidden from screen readers', () => {
    render(<BackLink to={{ name: 'start' }} label="Your groups" />);
    const link = screen.getByRole('link', { name: 'Your groups' });
    expect(link).toHaveAttribute('href', '#/');
    expect(link.querySelector('[aria-hidden="true"]')).toHaveTextContent('←');
  });
});

describe('Field', () => {
  it('ties its hint and its error to the input', async () => {
    const user = userEvent.setup();
    render(
      <Form>
        <Field
          name="who"
          label="Your name"
          hint="Only your group sees it."
          isRequired
          validate={(value) => (value.trim() === '' ? 'Add a name.' : null)}
        />
        <Button type="submit">Go</Button>
      </Form>,
    );
    const input = screen.getByRole('textbox', { name: 'Your name' });
    expect(input).toHaveAccessibleDescription('Only your group sees it.');

    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Only your group sees it. Add a name.');
    expect(input).toHaveFocus();
  });

  // React Aria shows a fixed field's new state on blur. The blur from pressing
  // submit would remove the error line, move the button up and lose the click.
  it.each([
    ['input', false],
    ['text area', true],
  ])('clears a shown error in its %s as soon as it’s fixed, before blur', async (_, multiline) => {
    const user = userEvent.setup();
    render(
      <Form>
        <Field
          name="who"
          label="Your name"
          hint="Only your group sees it."
          multiline={multiline}
          isRequired
          validate={(value) => (value.trim() === '' ? 'Add a name.' : null)}
        />
        <Button type="submit">Go</Button>
      </Form>,
    );
    const input = screen.getByRole('textbox', { name: 'Your name' });
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(input).toHaveAccessibleDescription('Only your group sees it. Add a name.');

    await user.type(input, 'Ana');
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription('Only your group sees it.');
    expect(screen.queryByText('Add a name.')).not.toBeInTheDocument();
  });

  it('keeps a shown error, updated, while the text is still wrong', async () => {
    const user = userEvent.setup();
    render(
      <Form>
        <Field
          name="code"
          label="Code"
          validate={(value) => (value.length < 3 ? `${String(3 - value.length)} to go.` : null)}
        />
        <Button type="submit">Go</Button>
      </Form>,
    );
    const input = screen.getByRole('textbox', { name: 'Code' });
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(input).toHaveAccessibleDescription('3 to go.');

    await user.type(input, 'a');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('2 to go.');
  });

  it('clears a refusal from the form, such as “too long to send”, once the text changes', async () => {
    const user = userEvent.setup();
    render(
      <Form validationErrors={{ text: 'Too long to send.' }}>
        <Field name="text" label="New text" multiline defaultValue="Long" />
      </Form>,
    );
    const area = screen.getByRole('textbox', { name: 'New text' });
    expect(area).toHaveAccessibleDescription('Too long to send.');

    await user.type(area, '!');
    expect(area).toHaveFocus();
    expect(area).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('Too long to send.')).not.toBeInTheDocument();
  });

  it('waits for blur or submit before showing an error the person hasn’t seen yet', async () => {
    const user = userEvent.setup();
    render(
      <Form>
        <Field
          name="link"
          label="Link"
          validate={(value) => (value.startsWith('https://') ? null : 'Paste a whole link.')}
        />
      </Form>,
    );
    const input = screen.getByRole('textbox', { name: 'Link' });
    await user.type(input, 'htt');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('Paste a whole link.')).not.toBeInTheDocument();

    await user.tab();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Paste a whole link.');
  });

  it('renders a text area when multiline', () => {
    render(<Field name="text" label="Document text" multiline inputClassName="input-document" />);
    const area = screen.getByRole('textbox', { name: 'Document text' });
    expect(area.tagName).toBe('TEXTAREA');
    expect(area).toHaveClass('input', 'input-document');
  });
});
