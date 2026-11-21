import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Worded } from './Worded';

describe('Worded (#549)', () => {
  it('fills each placeholder with its name, each in its own bdi', () => {
    const { container } = render(
      <p>
        <Worded template="{a} sits in {b}, and {a} stays." names={{ a: 'Oak', b: 'Metro' }} />
      </p>,
    );
    expect(container).toHaveTextContent('Oak sits in Metro, and Oak stays.');
    expect([...container.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual([
      'Oak',
      'Metro',
      'Oak',
    ]);
  });

  it('leaves a placeholder with no name as written', () => {
    const { container } = render(<Worded template="Hello {who}." names={{}} />);
    expect(container).toHaveTextContent('Hello {who}.');
    expect(container.querySelector('bdi')).toBeNull();
  });
});
