/**
 * The one Markdown reader for Atom text (ADR-0023; docs/spec/phase-1-spec.md §8).
 *
 * Atom text arrives from the group log, so it is untrusted: nothing a member
 * types may run script, load anything or follow a link outside http(s) and
 * mailto. Three walls stand between the text and the page:
 *
 * 1. markdown-it reads a CommonMark subset: raw HTML off (the `commonmark`
 *    preset turns it on, so `html: false` is passed explicitly), images off,
 *    and every link checked by {@link safeHref}.
 * 2. Nothing is ever parsed as HTML. {@link renderTokens} builds React
 *    elements from an allowlist of tokens, and React escapes all text.
 * 3. Any token outside the allowlist, or any error, shows the Atom's source as
 *    plain text instead ({@link renderAtom}).
 *
 * The deploy CSP (spec §9) is the fourth wall, behind these.
 */
import MarkdownIt, { type Token } from 'markdown-it';
import { createElement, Fragment, type ReactNode } from 'react';

import { messages } from '../messages';

/** The link schemes Atom text may use. */
export const MARKDOWN_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

/**
 * The parsed `href` of an absolute link whose scheme is in `protocols`, or
 * null for anything else. There is no base URL, so a relative link is refused
 * rather than resolved against the app. Returning the parsed `href` means what
 * renders is exactly what was checked.
 */
export function safeHref(
  href: string,
  protocols: ReadonlySet<string> = MARKDOWN_PROTOCOLS,
): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return protocols.has(url.protocol) ? url.href : null;
}

const md = new MarkdownIt('commonmark', { html: false });
md.disable('image');
md.validateLink = (url: string): boolean => safeHref(url) !== null;

/** Parses one Atom's text into markdown-it tokens, with a fresh environment each time. */
export function parseAtom(text: string): Token[] {
  return md.parse(text, {});
}

/** An inline token's words: text and code as they read, a soft break as a space. */
function inlineWords(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'code_inline':
      return token.content;
    case 'softbreak':
      return ' ';
    case 'hardbreak':
      return '\n';
    default:
      return '';
  }
}

/**
 * One Atom's words with the Markdown taken out, for places that show text as
 * plain text, such as an invite's excerpt (#73): each block's text on a line
 * of its own, link targets and markup dropped. Raw HTML, which this parser
 * never reads as HTML, stays as the text it is.
 */
export function plainText(text: string): string {
  const lines = parseAtom(text).flatMap((token) => {
    if (token.type === 'inline') return [(token.children ?? []).map(inlineWords).join('')];
    if (token.type === 'code_block' || token.type === 'fence') return [token.content.trimEnd()];
    return [];
  });
  return lines.filter((line) => line !== '').join('\n');
}

/** Builds one element from a closed block or inline token and its children. */
type Build = (token: Token, key: number, children: ReactNode[]) => ReactNode;

/** An element on its way: the open token, how to build it, and the children gathered so far. */
interface Frame {
  readonly token: Token;
  readonly key: number;
  readonly build: Build;
  readonly children: ReactNode[];
}

/** A plain element with `dir="auto"`, for blocks whose direction comes from their own text. */
const block =
  (tag: string): Build =>
  (_token, key, children) =>
    createElement(tag, { key, dir: 'auto' }, ...children);

/** A plain element with no attributes. */
const plain =
  (tag: string): Build =>
  (_token, key, children) =>
    createElement(tag, { key }, ...children);

/** Children with no element around them. */
const bare: Build = (_token, key, children) => createElement(Fragment, { key }, ...children);

/** The deepest heading HTML has. */
const DEEPEST_HEADING = 6;

/** An Atom's `#` is an `h2`: the screen's own `h1` sits above every Atom. Clamped at `h6`. */
const heading: Build = (token, key, children) => {
  if (!/^h[1-6]$/.test(token.tag)) throw refuse(token);
  const level = Math.min(Number(token.tag.slice(1)) + 1, DEEPEST_HEADING);
  return createElement(`h${String(level)}`, { key, dir: 'auto' }, ...children);
};

/** A tight list's paragraphs are hidden: their text sits directly in the list item. */
const paragraph: Build = (token, key, children) =>
  token.hidden ? bare(token, key, children) : block('p')(token, key, children);

/** A numbered list, keeping its first number when that isn't 1. */
const orderedList: Build = (token, key, children) => {
  const start = Number(token.attrGet('start') ?? Number.NaN);
  const props = Number.isSafeInteger(start) ? { key, start } : { key };
  return createElement('ol', props, ...children);
};

/**
 * A link, re-checked here: markdown-it can leave an empty or refused href on
 * a link it rejected. A refused link shows its text alone. A kept one opens
 * in a new tab with no opener and no referrer, and says so to screen readers.
 */
const link: Build = (token, key, children) => {
  const href = safeHref(String(token.attrGet('href') ?? ''));
  if (href === null) return bare(token, key, children);
  return createElement(
    'a',
    { key, href, target: '_blank', rel: 'noopener noreferrer' },
    ...children,
    createElement(
      'span',
      { key: 'new-tab', className: 'visually-hidden' },
      ` ${messages.app.newTab}`,
    ),
  );
};

/** Each open token the allowlist takes, keyed by type, with how to build its element. */
const OPEN: ReadonlyMap<string, Build> = new Map([
  ['paragraph_open', paragraph],
  ['heading_open', heading],
  ['bullet_list_open', plain('ul')],
  ['ordered_list_open', orderedList],
  ['list_item_open', block('li')],
  ['blockquote_open', block('blockquote')],
  ['em_open', plain('em')],
  ['strong_open', plain('strong')],
  ['link_open', link],
]);

/** A code block, fenced or indented, set as written. The fence's language is ignored. */
const codeBlock = (token: Token, key: number): ReactNode =>
  createElement('pre', { key }, createElement('code', null, token.content));

/** Each token with no children of its own, keyed by type, with what it becomes. */
const LEAF: ReadonlyMap<string, (token: Token, key: number) => ReactNode> = new Map([
  ['text', (token: Token) => token.content],
  ['softbreak', () => '\n'],
  ['hardbreak', (_token: Token, key: number) => createElement('br', { key })],
  ['code_inline', (token: Token, key: number) => createElement('code', { key }, token.content)],
  ['code_block', codeBlock],
  ['fence', codeBlock],
  ['hr', (_token: Token, key: number) => createElement('hr', { key })],
  [
    'inline',
    (token: Token, key: number) =>
      createElement(Fragment, { key }, ...renderTokens(token.children ?? [])),
  ],
]);

/** The error for a token the allowlist doesn't take. */
function refuse(token: Token): Error {
  return new Error(`Atom text holds a token outside the allowlist: ${token.type}`);
}

/** The element a leaf token becomes, or an error for a type outside the allowlist. */
function leaf(token: Token, key: number): ReactNode {
  const make = LEAF.get(token.type);
  if (make === undefined) throw refuse(token);
  return make(token, key);
}

/** Starts the element for an open token, or throws for a type outside the allowlist. */
function open(token: Token, key: number): Frame {
  const build = OPEN.get(token.type);
  if (build === undefined) throw refuse(token);
  return { token, key, build, children: [] };
}

/** Finishes the element on top of the stack, which `token` must close. */
function close(stack: Frame[], token: Token): ReactNode {
  const frame = stack.pop();
  if (frame === undefined || frame.token.type.replace(/_open$/, '_close') !== token.type) {
    throw refuse(token);
  }
  return frame.build(frame.token, frame.key, frame.children);
}

/**
 * Builds React elements from markdown-it tokens, allowing only p, h2–h6, em,
 * strong, ul, ol, li, a, blockquote, code, pre, br and hr.
 *
 * @throws {Error} for any other token, or for opens and closes that don't pair.
 */
export function renderTokens(tokens: readonly Token[]): ReactNode[] {
  const root: ReactNode[] = [];
  const stack: Frame[] = [];
  tokens.forEach((token, key) => {
    if (token.nesting === 1) {
      stack.push(open(token, key));
      return;
    }
    const node = token.nesting === -1 ? close(stack, token) : leaf(token, key);
    (stack.at(-1)?.children ?? root).push(node);
  });
  const unclosed = stack.at(-1);
  if (unclosed !== undefined) throw refuse(unclosed.token);
  return root;
}

/**
 * One Atom's text as React elements: formatted when every token is on the
 * allowlist, else its source as plain text. `parse` is markdown-it's parser
 * unless a test passes another.
 */
export function renderAtom(
  text: string,
  parse: (text: string) => readonly Token[] = parseAtom,
): ReactNode[] {
  try {
    return renderTokens(parse(text));
  } catch {
    return [createElement('p', { key: 'plain', className: 'atom-plain', dir: 'auto' }, text)];
  }
}
