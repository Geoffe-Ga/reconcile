import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InvitePreview } from './InvitePreview';

const PREVIEW = {
  groupName: 'Riverside Tenants',
  inviterName: 'Ana',
  documentTitle: 'House rules',
  excerpt: 'Quiet hours start at ten.',
};

describe('InvitePreview', () => {
  it('says whose invite it is, then the Document’s title and first section', () => {
    const { container } = render(<InvitePreview preview={PREVIEW} />);
    expect(container.querySelector('.invite-from')).toHaveTextContent('From Ana’s invite');
    expect(screen.getByText('Their Document')).toBeVisible();
    expect(screen.getByText('House rules')).toBeVisible();
    expect(screen.getByText('Quiet hours start at ten.')).toBeVisible();
  });

  it('shows every field as plain text in its own <bdi>, never as Markdown or HTML', () => {
    const preview = {
      groupName: 'g',
      inviterName: '<img src=x onerror="alert(1)">',
      documentTitle: '**Bold** <b>title</b>',
      excerpt: '<script>alert(1)</script> [x](javascript:alert(1))',
    };
    const { container } = render(<InvitePreview preview={preview} />);
    expect(container.querySelector('img, script, a, b, strong')).toBeNull();
    const bdis = [...container.querySelectorAll('bdi')].map((bdi) => bdi.textContent);
    expect(bdis).toEqual([preview.inviterName, preview.documentTitle, preview.excerpt]);
  });

  it('leaves out an empty excerpt', () => {
    const { container } = render(<InvitePreview preview={{ ...PREVIEW, excerpt: '' }} />);
    expect(container.querySelector('.invite-excerpt')).toBeNull();
  });
});
