import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SendStatus } from './SendStatus';

describe('SendStatus', () => {
  it('says nothing before anything is sent, but keeps its live region ready', () => {
    render(<SendStatus pending={false} reachable sent={false} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('says it is sending while the event waits in the outbox and the relay answers', () => {
    render(<SendStatus pending reachable sent={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Sending…');
  });

  it('says it is saved on this device while the relay can’t be reached', () => {
    render(<SendStatus pending reachable={false} sent={false} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saved on this device. It will send when you’re back online.',
    );
  });

  it('says Sent once the event has left the outbox', () => {
    const { rerender } = render(<SendStatus pending reachable={false} sent />);
    expect(screen.getByRole('status')).toHaveTextContent('Saved on this device.');
    rerender(<SendStatus pending={false} reachable sent />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Sent$/);
  });
});
