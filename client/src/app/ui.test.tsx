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

  it('renders a text area when multiline', () => {
    render(<Field name="text" label="Document text" multiline inputClassName="input-document" />);
    const area = screen.getByRole('textbox', { name: 'Document text' });
    expect(area.tagName).toBe('TEXTAREA');
    expect(area).toHaveClass('input', 'input-document');
  });
});
