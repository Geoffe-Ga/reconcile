/**
 * `<AtomText>` (#70, ADR-0023): the only renderer of Atom text. Nothing a
 * member types may run script, load anything or follow a link outside
 * http(s) and mailto, so every hostile vector here must render as inert text.
 */
import { render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../../test/axe';
import { AtomText } from './AtomText';

/** Every element `<AtomText>` may produce: its wrapper, the allowlist, and hidden link text. */
const ALLOWED = new Set([
  'DIV',
  'P',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'EM',
  'STRONG',
  'UL',
  'OL',
  'LI',
  'A',
  'BLOCKQUOTE',
  'CODE',
  'PRE',
  'BR',
  'HR',
  'SPAN',
]);

/** Attributes that load something or point somewhere. Only `a[href]` may point, and only safely. */
const LOADING = ['src', 'srcset', 'srcdoc', 'action', 'formaction', 'data', 'poster', 'background'];

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Fails unless `root` holds only allowlisted elements, no handlers, and only safe links. */
function expectInert(root: HTMLElement): void {
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    expect(ALLOWED, element.outerHTML).toContain(element.tagName);
    // No style attribute either: the deploy CSP allows none in markup.
    expect(element.hasAttribute('style'), element.outerHTML).toBe(false);
    for (const { name } of Array.from(element.attributes)) {
      expect(name.toLowerCase(), element.outerHTML).not.toMatch(/^on/);
      expect(LOADING, element.outerHTML).not.toContain(name.toLowerCase());
      expect(name.toLowerCase(), element.outerHTML).not.toMatch(/^xlink/);
    }
    if (element.hasAttribute('href')) {
      expect(element.tagName).toBe('A');
      const href = element.getAttribute('href') ?? '';
      expect(SAFE_PROTOCOLS).toContain(new URL(href).protocol);
    }
  }
}

function renderText(text: string): HTMLElement {
  const { container } = render(<AtomText text={text} />);
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('Expected the Atom’s wrapper.');
  return root;
}

describe('AtomText refuses hostile input', () => {
  it.each([
    ['a script tag', '<script>alert(1)</script>\n'],
    ['an img with an event handler', '<img src=x onerror=alert(1)>\n'],
    ['a javascript: link', '[x](javascript:alert(1))\n'],
    ['a mixed-case JaVaScRiPt: link', '[x](JaVaScRiPt:alert(1))\n'],
    ['a javascript: autolink', '<javascript:alert(1)>\n'],
    ['a data: link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)\n'],
    ['an image', '![x](https://example.com/t.png)\n'],
    ['a raw div with a handler', '<div onmouseover="alert(1)">hi</div>\n'],
    ['a raw iframe', '<iframe src="https://example.com"></iframe>\n'],
    ['a vbscript: link', '[x](vbscript:msgbox(1))\n'],
    ['an entity-encoded colon', '[x](javascript&#58;alert(1))\n'],
    ['an entity-encoded first letter', '[x](&#106;avascript:alert(1))\n'],
    ['a percent-encoded first letter', '[x](%6Aavascript:alert(1))\n'],
    ['an angle-bracket destination', '[x](<javascript:alert(1)>)\n'],
    ['a reference definition', '[x][r]\n\n[r]: javascript:alert(1)\n'],
    ['a protocol-relative link', '[x](//evil.example/a)\n'],
    ['a relative link', '[x](/relative)\n'],
    ['a fragment link', '[x](#top)\n'],
    ['a file: link', '[x](file:///etc/passwd)\n'],
    ['a raw SVG with onload', '<svg onload=alert(1)>\n'],
    ['a raw anchor', '<a href="javascript:alert(1)">x</a>\n'],
    ['raw object and embed', '<object data="x"></object><embed src="x">\n'],
    ['a raw style element', '<style>body{display:none}</style>\n'],
    ['a raw form', '<form action="https://example.com"><input name="key"></form>\n'],
    ['a raw base element', '<base href="https://evil.example/">\n'],
    ['raw MathML with xlink', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>\n'],
    [
      'an image inside a javascript: link',
      '[![x](https://example.com/t.png)](javascript:alert(1))\n',
    ],
    ['a link title that looks like a handler', '[x](https://example.com "onmouseover=alert(1)")\n'],
    ['script inside inline code', '`<script>alert(1)</script>`\n'],
    ['script inside a fenced block', '```html\n<script>alert(1)</script>\n```\n'],
    ['an HTML comment', '<!-- <script>alert(1)</script> -->\n'],
    ['a line break inside the scheme', '[x](java\nscript:alert(1))\n'],
  ])('renders %s as inert text', (_name, text) => {
    const root = renderText(text);
    expectInert(root);
    expect(
      root.querySelector('script, img, iframe, object, embed, svg, math, style, form'),
    ).toBeNull();
  });

  it('shows raw HTML as the text it is', () => {
    const root = renderText('<img src=x onerror=alert(1)> and <b>bold</b>\n');
    expect(root).toHaveTextContent('<img src=x onerror=alert(1)> and <b>bold</b>');
    expect(root.querySelector('b')).toBeNull();
  });

  it('shows a refused link’s text and no link', () => {
    const root = renderText('[click me](javascript:alert(1))\n');
    expect(root.querySelector('a')).toBeNull();
    expect(root).toHaveTextContent('click me');
  });

  it('turns an image into its alt text and a plain link, so nothing loads', () => {
    const root = renderText('![a cat](https://example.com/cat.png)\n');
    expect(root.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: /a cat/ });
    expect(link).toHaveAttribute('href', 'https://example.com/cat.png');
  });

  it('keeps every element on the allowlist whatever the Markdown', () => {
    const token = fc.constantFrom(
      '<',
      '>',
      '[',
      ']',
      '(',
      ')',
      '!',
      '*',
      '_',
      '`',
      '#',
      '- ',
      '1. ',
      '> ',
      '\n',
      '\n\n',
      ' ',
      '    ',
      '\\',
      '"',
      "'",
      '&#58;',
      '&#x6A;',
      '%3A',
      'javascript:',
      'JaVaScRiPt:',
      'data:',
      'vbscript:',
      'https://example.com/',
      'mailto:a@example.com',
      '//evil.example',
      'script',
      'img src=x ',
      'onerror=alert(1)',
      'iframe',
      'a',
      'x',
    );
    fc.assert(
      fc.property(fc.array(token, { maxLength: 30 }), (tokens) => {
        const { container, unmount } = render(<AtomText text={tokens.join('')} />);
        const root = container.firstElementChild;
        expect(root).toBeInstanceOf(HTMLElement);
        expectInert(root as HTMLElement);
        unmount();
      }),
      { numRuns: 300 },
    );
  }, 30_000);
});

describe('AtomText formats the CommonMark subset', () => {
  it('sets paragraphs, emphasis, strong and inline code', () => {
    const root = renderText('Quiet *after* **ten**, see `rule 3`.\n\nSecond paragraph.\n');
    const paragraphs = root.querySelectorAll(':scope > p');
    expect(Array.from(paragraphs).map((p) => p.textContent)).toEqual([
      'Quiet after ten, see rule 3.',
      'Second paragraph.',
    ]);
    expect(root.querySelector('em')).toHaveTextContent('after');
    expect(root.querySelector('strong')).toHaveTextContent('ten');
    expect(root.querySelector('code')).toHaveTextContent('rule 3');
    expect(paragraphs[0]).toHaveAttribute('dir', 'auto');
  });

  it('moves each heading down one level, so an Atom’s # is an h2, clamped at h6', () => {
    renderText('# One\n\n## Two\n\n##### Five\n\n###### Six\n\nSetext\n===\n');
    expect(screen.getByRole('heading', { level: 2, name: 'One' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 3, name: 'Two' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 6, name: 'Five' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 6, name: 'Six' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Setext' })).toBeVisible();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('sets bullet and numbered lists, keeping a list’s first number', () => {
    const root = renderText('- Be kind\n- Ask first\n\n3. Third\n4. Fourth\n');
    expect(screen.getAllByRole('list')).toHaveLength(2);
    expect(root.querySelector('ul')?.textContent).toBe('Be kindAsk first');
    expect(root.querySelector('ol')).toHaveAttribute('start', '3');
    expect(root.querySelectorAll('li')).toHaveLength(4);
    // A tight list's items hold their text directly, with no paragraph inside.
    expect(root.querySelector('li > p')).toBeNull();
  });

  it('keeps paragraphs inside a loose list’s items', () => {
    const root = renderText('- one\n\n  more\n- two\n');
    expect(root.querySelectorAll('li > p')).toHaveLength(3);
    expect(root.querySelector('ol')).toBeNull();
  });

  it('starts a numbered list at 1 without a start attribute', () => {
    const root = renderText('1. First\n2. Second\n');
    expect(root.querySelector('ol')).not.toHaveAttribute('start');
  });

  it('sets block quotes, code blocks and rules', () => {
    const root = renderText('> Quoted\n\n```\nfenced <b>code</b>\n```\n\n    indented\n\n***\n');
    expect(root.querySelector('blockquote')).toHaveTextContent('Quoted');
    const blocks = Array.from(root.querySelectorAll('pre > code')).map((code) => code.textContent);
    expect(blocks).toEqual(['fenced <b>code</b>\n', 'indented\n']);
    expect(root.querySelector('hr')).not.toBeNull();
  });

  it('breaks a line only at a backslash, and joins soft line breaks', () => {
    const root = renderText('one\\\ntwo\nthree\n');
    expect(root.querySelectorAll('br')).toHaveLength(1);
    expect(root.querySelector('p')?.textContent).toBe('onetwo\nthree');
  });

  it('opens http, https and mailto links in a new tab, with no referrer', () => {
    renderText('[Our site](https://example.org/a), <http://example.net>, <ana@example.org>\n');
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.org/a',
      'http://example.net/',
      'mailto:ana@example.org',
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    // The hidden note's leading space is inside it, so no visible gap opens before a comma.
    // Browsers keep that space in the name; jsdom's name computation drops it.
    expect(screen.getByRole('link', { name: /^Our site ?\(opens in a new tab\)$/ })).toBeVisible();
  });

  it('drops a link’s title, which could carry anything', () => {
    renderText('[x](https://example.com "A title")\n');
    expect(screen.getByRole('link')).not.toHaveAttribute('title');
  });

  it('makes no link from a bare address: no linkify', () => {
    const root = renderText('See https://example.com for more.\n');
    expect(root.querySelector('a')).toBeNull();
  });

  it('keeps entities and escapes as the characters they stand for', () => {
    expect(renderText('&amp; &copy; \\*not emphasis\\*\n')).toHaveTextContent('& © *not emphasis*');
  });

  it('sets the Atom in the document style, with its direction from its own text', () => {
    const root = renderText('مرحبا\n');
    expect(root).toHaveClass('atom-text');
    expect(root).toHaveAttribute('dir', 'auto');
  });

  it('takes an extra class for where it sits', () => {
    expect(
      render(<AtomText text={'x\n'} className="atom-card" />).container.firstChild,
    ).toHaveClass('atom-text', 'atom-card');
  });

  it('renders nothing but its wrapper for empty text', () => {
    expect(renderText('').childElementCount).toBe(0);
  });

  it('passes axe', async () => {
    document.title = 'Document · Reconcile';
    render(
      <main>
        <h1>Document</h1>
        <AtomText
          text={'# Rules\n\nBe *kind*. See [our site](https://example.org).\n\n- One\n- Two\n'}
        />
      </main>,
    );
    expect(await axeViolations()).toEqual([]);
  });
});
