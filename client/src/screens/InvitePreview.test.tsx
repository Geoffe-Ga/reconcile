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

  it('heads the whole Document with the title, in place of the excerpt, and focuses it (#91)', () => {
    const preview = { ...PREVIEW, documentTitle: '<b>House</b> **rules**' };
    const { container } = render(
      <InvitePreview preview={preview}>
        <p>The whole Document.</p>
      </InvitePreview>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: preview.documentTitle });
    expect(heading).toHaveFocus();
    expect(screen.getByText('The whole Document.')).toBeVisible();
    expect(screen.queryByText(PREVIEW.excerpt)).not.toBeInTheDocument();
    const bdis = [...container.querySelectorAll('bdi')].map((bdi) => bdi.textContent);
    expect(bdis).toEqual([preview.inviterName, preview.documentTitle]);
    expect(container.querySelector('b, strong, .invite-excerpt')).toBeNull();
  });

  it('takes no focus and no heading where it previews, as on the install guide', () => {
    render(<InvitePreview preview={PREVIEW} />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it('leaves out an empty excerpt', () => {
    const { container } = render(<InvitePreview preview={{ ...PREVIEW, excerpt: '' }} />);
    expect(container.querySelector('.invite-excerpt')).toBeNull();
  });
});
