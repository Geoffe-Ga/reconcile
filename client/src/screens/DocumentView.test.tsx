import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../test/axe';
import { testGroup } from '../test/groups';
import { DocumentView } from './DocumentView';

describe('DocumentView', () => {
  it('sets each section as plain text in the document style, under the title', async () => {
    const { state } = testGroup({
      atoms: ['Quiet hours start at ten.', 'Bins go out\non Tuesday.'],
    });
    const { container } = render(<DocumentView state={state} />);

    expect(screen.getByRole('heading', { level: 1, name: 'House rules' })).toBeVisible();
    const texts = Array.from(container.querySelectorAll('.atom-text'));
    expect(texts.map((node) => node.textContent)).toEqual([
      'Quiet hours start at ten.',
      'Bins go out\non Tuesday.',
    ]);
    expect(texts[0]).toHaveAttribute('dir', 'auto');
    expect(screen.getByRole('link', { name: 'Riverside Tenants' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}`,
    );
    expect(document.title).toBe('Document · Reconcile');
    expect(await axeViolations()).toEqual([]);
  });

  it('never renders a section’s text as HTML', () => {
    const { state } = testGroup({ atoms: ['<img src=x onerror=alert(1)> and <b>bold</b>'] });
    const { container } = render(<DocumentView state={state} />);
    expect(container.querySelector('.atom-text img, .atom-text b')).toBeNull();
    expect(container.querySelector('.atom-text')).toHaveTextContent(
      '<img src=x onerror=alert(1)> and <b>bold</b>',
    );
  });

  it('offers Propose a change on each section, waiting for #66 to wire it', () => {
    const { state } = testGroup();
    render(<DocumentView state={state} />);
    const buttons = screen.getAllByRole('button', { name: /^Propose a change/ });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Propose a change to section 1',
      'Propose a change to section 2',
    ]);
    for (const button of buttons) {
      expect(button).toHaveTextContent('Propose a change');
      expect(button).toBeDisabled();
    }
  });

  it('proposes on the section pressed, once a handler is given', async () => {
    const user = userEvent.setup();
    const { state } = testGroup();
    const onPropose = vi.fn();
    render(<DocumentView state={state} onPropose={onPropose} />);
    await user.click(screen.getByRole('button', { name: 'Propose a change to section 2' }));
    expect(onPropose).toHaveBeenCalledWith(`${state.group ?? ''}.1`);
  });

  it('says so when the Document has no sections', async () => {
    const { state } = testGroup({ atoms: [] });
    render(<DocumentView state={state} />);
    expect(screen.getByText('This Document has no sections yet.')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });
});
