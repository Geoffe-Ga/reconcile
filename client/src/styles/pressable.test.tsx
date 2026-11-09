import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from 'react-aria-components';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import indexHtml from '../../index.html?raw';
import pressableCss from './pressable.css?raw';

/*
 * The deploy CSP (spec §9) blocks every inline <style>. React Aria's usePress
 * injects one at runtime unless an element with its id already exists, so
 * index.html claims the id and pressable.css ships the rule. These tests pin
 * that bargain to React Aria's code: an upgrade that changes the id, the rule
 * or the injection fails here instead of logging a CSP violation for members.
 * jsdom doesn't enforce CSP, so "no inline <style> is added" stands in for it.
 */

/** The id of the `<style>` usePress injects, which it looks up first so it injects only once. */
const STYLE_ID = 'react-aria-pressable-style';

/** What to do when one of these tests fails, most likely after a React Aria upgrade. */
const ON_UPGRADE =
  'React Aria’s pressable <style> no longer matches our CSP answer (#150). Re-read its ' +
  'usePress, then update src/styles/pressable.css and the claim in index.html to match.';

/** CSS text without comments or layout, so the same rule compares equal however it is wrapped. */
function cssRules(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The element in index.html's `<head>` that claims React Aria's style id. */
function indexHtmlClaim(): Element | null {
  const page = new DOMParser().parseFromString(indexHtml, 'text/html');
  return page.head.querySelector(`#${STYLE_ID}`);
}

/** Records every `<style>` element added anywhere in the document, even one removed again. */
function watchInlineStyles(): () => HTMLStyleElement[] {
  const added: HTMLStyleElement[] = [];
  const collect = (records: MutationRecord[]) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLStyleElement) added.push(node);
        if (node instanceof Element) added.push(...node.querySelectorAll('style'));
      }
    }
  };
  const observer = new MutationObserver(collect);
  observer.observe(document, { childList: true, subtree: true });
  return () => {
    collect(observer.takeRecords());
    observer.disconnect();
    return added;
  };
}

/** Renders a React Aria button, presses it, and returns it. */
async function renderAndPress(): Promise<HTMLElement> {
  render(<Button>Create an organization</Button>);
  const button = screen.getByRole('button', { name: 'Create an organization' });
  await userEvent.click(button);
  return button;
}

describe('React Aria’s pressable style under the deploy CSP', () => {
  beforeEach(() => {
    // usePress skips its injection when NODE_ENV is 'test'. Production builds run it.
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    document.head.replaceChildren();
  });

  it('without a claim, React Aria injects an inline <style> with exactly the rule we ship', async () => {
    const button = await renderAndPress();

    const injected = document.getElementById(STYLE_ID);
    expect(injected, ON_UPGRADE).toBeInstanceOf(HTMLStyleElement);
    expect(button, ON_UPGRADE).toHaveAttribute('data-react-aria-pressable');
    expect(cssRules(pressableCss), ON_UPGRADE).toBe(cssRules(injected?.textContent ?? ''));
  });

  it('index.html claims the id in <head> with an inert element, not an inline style', () => {
    const claim = indexHtmlClaim();

    expect(claim?.localName).toBe('meta');
  });

  it('with index.html’s claim, pressing a React Aria button adds no inline <style>', async () => {
    const claim = indexHtmlClaim();
    if (claim !== null) document.head.append(document.importNode(claim, true));
    const insertedStyles = watchInlineStyles();

    await renderAndPress();

    expect(insertedStyles(), ON_UPGRADE).toEqual([]);
    expect(document.querySelectorAll('style')).toHaveLength(0);
    expect(document.getElementById(STYLE_ID)?.localName).toBe('meta');
  });
});
