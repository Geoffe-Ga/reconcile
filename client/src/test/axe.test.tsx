import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { axeViolations } from './axe';

describe('axeViolations', () => {
  beforeEach(() => {
    document.title = 'Test page';
  });

  it('passes a page with one main landmark and one h1', async () => {
    render(
      <main>
        <h1>Title</h1>
        <p>Text</p>
      </main>,
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('names each violation and where it is', async () => {
    render(
      <main>
        <h1>Title</h1>
        <input type="text" />
      </main>,
    );
    const violations = await axeViolations();
    expect(violations).toEqual([expect.stringMatching(/^label: .+\(input\)$/)]);
  });

  it('applies page-level best practices, such as content inside landmarks', async () => {
    render(
      <>
        <main>
          <h1>Title</h1>
        </main>
        <p>Stray text</p>
      </>,
    );
    expect(await axeViolations()).toEqual([expect.stringMatching(/^region: /)]);
  });
});
