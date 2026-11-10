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

  it('leaves focus alone when a heading below takes it, as on Join (#91)', () => {
    render(<PageHeader title="Riverside Tenants" pageTitle="Join a group" takesFocus={false} />);
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
    expect(document.title).toBe('Join a group · Reconcile');
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

  it('keeps its error’s line, so an error shown or cleared on blur moves nothing (#165)', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Form>
        <Field
          name="link"
          label="Chat link"
          validate={(value) =>
            value === '' || value.startsWith('https://') ? null : 'Use a link.'
          }
        />
        <Button type="submit">Go</Button>
      </Form>,
    );
    const input = screen.getByRole('textbox', { name: 'Chat link' });
    // jsdom has no layout, so the line app.css holds open is found by its class.
    const line = container.querySelector('.field-error-line');
    expect(line).toBeEmptyDOMElement();
    expect(input).not.toHaveAttribute('aria-invalid');

    await user.type(input, 'chat.example.org');
    await user.tab();
    expect(line).toHaveTextContent('Use a link.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Use a link.');

    await user.clear(input);
    await user.type(input, 'https://chat.example.org');
    await user.tab();
    expect(container.querySelector('.field-error-line')).toBe(line);
    expect(line).toBeEmptyDOMElement();
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAccessibleDescription('');
  });

  it('keeps an error line only where an error can come and go on blur', () => {
    const check = () => 'Never right.';
    render(
      <>
        <Field label="Your name" isRequired />
        <Field label="Invite link" value="https://example.org" isReadOnly validate={check} />
        <Field label="Your note" isDisabled isRequired />
        <Field label="Anything" />
      </>,
    );
    const holdsLine = (name: string) => {
      const field = screen.getByRole('textbox', { name }).closest('.field');
      return Boolean(field?.querySelector('.field-error-line'));
    };
    expect(['Your name', 'Invite link', 'Your note', 'Anything'].map(holdsLine)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('renders a text area when multiline', () => {
    render(<Field name="text" label="Document text" multiline inputClassName="input-document" />);
    const area = screen.getByRole('textbox', { name: 'Document text' });
    expect(area.tagName).toBe('TEXTAREA');
    expect(area).toHaveClass('input', 'input-document');
  });
});
