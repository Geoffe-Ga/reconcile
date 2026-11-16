/**
 * The link bar's scrim (#444) is `position: fixed` inside the band, so it
 * covers the whole window only while nothing on the band makes it the
 * containing block for fixed descendants. A transform, `will-change` on
 * one, a filter or `contain` would shrink the scrim to the band: the page
 * would show uncovered, and a tap on it wouldn't empty the bar.
 */
import { describe, expect, it } from 'vitest';

import linkbarCss from './linkbar.css?raw';

/** The declarations of the first rule whose selector is exactly `selector`, comments left out. */
function ruleOf(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start === -1) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//gu, '');
}

describe('the link bar band at rest', () => {
  it('makes no containing block, so the scrim covers the whole window', () => {
    const band = ruleOf(linkbarCss, '.link-bar-band');
    for (const property of ['will-change', 'transform:', 'filter', 'contain', 'perspective']) {
      expect(band).not.toContain(property);
    }
  });
});
