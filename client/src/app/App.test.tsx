import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App';

describe('App shell', () => {
  it('names the product and the core idea', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Your group’s living documents',
    );
    expect(screen.getByText(/whatever survives the vote/)).toBeInTheDocument();
  });

  it('offers exactly one primary action, as an accessible button', () => {
    render(<App />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Create an organization' })).toBeEnabled();
  });
});
