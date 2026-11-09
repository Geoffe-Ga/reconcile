import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChatLink } from './ChatLink';

describe('ChatLink', () => {
  it('links a web chat in a new tab, with no opener or referrer', () => {
    render(<ChatLink href="https://discord.gg/abc123" />);
    const link = screen.getByRole('link', { name: 'Join discussion (opens in a new tab)' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://discord.gg/abc123');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('Join discussion ↗');
  });

  it('renders the link as parsed, so what shows is what was checked', () => {
    render(<ChatLink href="HTTPS://Chat.Example.org/room" />);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://chat.example.org/room');
  });

  it.each([
    ['no link', null],
    ['a javascript: link', 'javascript:alert(1)'],
    ['a data: link', 'data:text/html,<b>hi</b>'],
    ['a relative link', '/elsewhere'],
  ])('renders nothing for %s', (_label, href) => {
    const { container } = render(<ChatLink href={href} />);
    expect(container).toBeEmptyDOMElement();
  });
});
