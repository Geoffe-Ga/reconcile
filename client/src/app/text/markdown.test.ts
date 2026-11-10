/**
 * The one markdown-it instance, its link check and its token walker (#70).
 */
import { render } from '@testing-library/react';
import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';

import { MARKDOWN_PROTOCOLS, parseAtom, renderAtom, renderTokens, safeHref } from './markdown';

/** Renders walker output inside a div and returns the div. */
function mount(nodes: ReturnType<typeof renderAtom>): HTMLElement {
  const { container } = render(createElement(Fragment, null, ...nodes));
  return container;
}

describe('safeHref', () => {
  it.each([
    ['https://example.org/a b', 'https://example.org/a%20b'],
    ['HTTP://Example.org', 'http://example.org/'],
    ['mailto:ana@example.org', 'mailto:ana@example.org'],
  ])('accepts %j as the href it parses to', (href, parsed) => {
    expect(safeHref(href)).toBe(parsed);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0000javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.org/uuid',
    'ftp://example.org',
    '//example.org/relative',
    '/relative/path',
    '#fragment',
    '%6Aavascript:alert(1)',
    'example.org',
    'https://',
    '',
  ])('refuses %j', (href) => {
    expect(safeHref(href)).toBeNull();
  });

  it('allows only http, https and mailto by default', () => {
    expect([...MARKDOWN_PROTOCOLS].sort()).toEqual(['http:', 'https:', 'mailto:']);
  });

  it('takes a narrower set, as the chat-link check does', () => {
    const web = new Set(['http:', 'https:']);
    expect(safeHref('mailto:ana@example.org', web)).toBeNull();
    expect(safeHref('https://example.org', web)).toBe('https://example.org/');
  });
});

describe('the markdown-it instance', () => {
  it('turns raw HTML off, though the commonmark preset turns it on', () => {
    const types = parseAtom('<div>x</div>\n\n<b>y</b>\n').flatMap((token) => [
      token.type,
      ...(token.children ?? []).map((child) => child.type),
    ]);
    expect(types).not.toContain('html_block');
    expect(types).not.toContain('html_inline');
  });

  it('turns images off', () => {
    const children = parseAtom('![x](https://example.com/t.png)\n')[1]?.children ?? [];
    expect(children.map((child) => child.type)).not.toContain('image');
  });

  it('checks every link with safeHref', () => {
    const inline = (text: string) =>
      (parseAtom(text)[1]?.children ?? []).map((child) => child.type);
    expect(inline('[x](https://example.org)\n')).toContain('link_open');
    expect(inline('[x](javascript:alert(1))\n')).not.toContain('link_open');
  });

  it('parses each call afresh, sharing nothing between Atoms', () => {
    expect(parseAtom('[x]: https://example.org\n')).toEqual([]);
    expect(parseAtom('[x]\n')[1]?.children?.map((child) => child.type)).toEqual(['text']);
  });
});

describe('renderTokens', () => {
  it('refuses a token outside the allowlist', () => {
    const tokens = parseAtom('x\n');
    const [open] = tokens;
    if (open === undefined) throw new Error('Expected a paragraph.');
    open.type = 'table_open';
    open.tag = 'table';
    expect(() => renderTokens(tokens)).toThrow('table_open');
  });

  it('refuses a close that matches no open', () => {
    const tokens = parseAtom('x\n');
    expect(() => renderTokens(tokens.slice(1))).toThrow('paragraph_close');
  });

  it('refuses an open that never closes', () => {
    const tokens = parseAtom('x\n');
    expect(() => renderTokens(tokens.slice(0, 2))).toThrow('paragraph_open');
  });

  it('re-checks a link’s href, rendering a refused one as its text alone', () => {
    const tokens = parseAtom('[x](https://example.org)\n');
    const link = tokens[1]?.children?.[0];
    if (link === undefined) throw new Error('Expected a link.');
    link.attrSet('href', 'javascript:alert(1)');
    const container = mount(renderTokens(tokens));
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('x');
  });

  it('renders a link with no href as its text alone', () => {
    const tokens = parseAtom('[x](https://example.org)\n');
    const link = tokens[1]?.children?.[0];
    if (link === undefined) throw new Error('Expected a link.');
    link.attrs = null;
    expect(mount(renderTokens(tokens)).querySelector('a')).toBeNull();
  });

  it('ignores a list start that isn’t a whole number', () => {
    const tokens = parseAtom('3. x\n');
    tokens[0]?.attrSet('start', '3" onclick="alert(1)');
    expect(mount(renderTokens(tokens)).querySelector('ol')).not.toHaveAttribute('start');
  });
});

describe('renderAtom', () => {
  it('falls back to the source as plain text when a token is outside the allowlist', () => {
    const parse = (text: string) => {
      const tokens = parseAtom(text);
      const [open] = tokens;
      if (open !== undefined) open.type = 'html_block';
      return tokens;
    };
    const container = mount(renderAtom('**x** <b>y</b>\n', parse));
    expect(container.querySelector('strong, b')).toBeNull();
    const plain = container.querySelector('p.atom-plain');
    expect(plain?.textContent).toBe('**x** <b>y</b>\n');
  });

  it('falls back to the source as plain text when parsing throws', () => {
    const parse = (): never => {
      throw new Error('parser bug');
    };
    expect(mount(renderAtom('*x*\n', parse)).querySelector('p.atom-plain')?.textContent).toBe(
      '*x*\n',
    );
  });

  it('formats through the shared instance by default', () => {
    expect(mount(renderAtom('*x*\n')).querySelector('em')).toHaveTextContent('x');
  });
});
