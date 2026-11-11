import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MotionTagText } from './MotionTag';

describe('MotionTagText (#120, #122)', () => {
  it('names a coalition’s own motion', () => {
    const { container } = render(<MotionTagText coalition="Eastside Housing" through={[]} />);
    expect(container).toHaveTextContent(/^Coalition vote · Eastside Housing$/);
  });

  it('names the route a motion from further up came by, nearest first, each name in a bdi', () => {
    const { container } = render(
      <MotionTagText coalition="Metro Renters" through={['Eastside Housing']} />,
    );
    expect(container).toHaveTextContent(
      /^Coalition vote · Metro Renters \(through Eastside Housing\)$/,
    );
    expect(screen.getByText('Eastside Housing').tagName).toBe('BDI');
  });

  it('joins a longer route with “then”', () => {
    const { container } = render(
      <MotionTagText coalition="State Renters" through={['Eastside Housing', 'Metro Renters']} />,
    );
    expect(container).toHaveTextContent(
      'Coalition vote · State Renters (through Eastside Housing, then Metro Renters)',
    );
  });
});
