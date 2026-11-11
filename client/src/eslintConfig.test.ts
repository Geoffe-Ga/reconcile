/**
 * Regression tests for the rules eslint.config.js adds itself (#162): NO_CLOCK and
 * INTEGERS_ONLY in src/engine, the network globals outside src/net, the messages
 * rule in src/app and src/screens, NO_RAW_HTML across src/ (#70), and
 * `navigator.credentials` outside src/platform/webauthn.ts (#95). Each must fire on a bad snippet where it applies,
 * and stay quiet on a good snippet or where it doesn't apply.
 *
 * The snippets are linted in memory as if they were files at the paths given, with
 * the repo's own config: its `files` and `ignores` globs and its rule options. Two
 * things differ, and neither touches those rules. Only those rules run, so a message
 * here is theirs (or a parse error). And the snippets parse without type information,
 * because the type-aware parser only sees files on disk; these rules match syntax and
 * scope, never types.
 */
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/** The core rules eslint.config.js configures with the repo's own selectors and names. */
const OWN_RULES = new Set([
  'no-restricted-syntax',
  'no-restricted-globals',
  'no-restricted-properties',
]);

// ESLint reads client/eslint.config.js from the working directory, client/, as `npm run lint` does.
const eslint = new ESLint({
  overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
  ruleFilter: ({ ruleId }) => OWN_RULES.has(ruleId),
});

/** Each message from linting `code` as the file at `filePath`, as "rule: message". */
async function lint(code: string, filePath: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath });
  expect(results).toHaveLength(1);
  return results.flatMap(({ messages }) =>
    messages.map(({ ruleId, message }) => `${ruleId ?? 'parse error'}: ${message}`),
  );
}

// Loading the config and its plugins takes about a second: do it once, before any test's timeout.
beforeAll(async () => {
  await eslint.calculateConfigForFile('src/app/fixture.ts');
}, 30_000);

describe('NO_CLOCK: src/engine reads no clock', () => {
  const CLOCK =
    'no-restricted-syntax: src/engine reads no clock. Use relay time (`received`, `relayNow`).';

  it.each([
    ['Date by name', 'export const clock: unknown = Date;'],
    ['performance by name', 'export const clock: unknown = performance;'],
    ['Date by a string key', "export const clock: unknown = globalThis['Date'];"],
    ['performance by a string key', "export const clock: unknown = globalThis['performance'];"],
    ['Date by a plain template key', 'export const clock: unknown = globalThis[`Date`];'],
    ['performance by a plain template key', 'export const clock: unknown = self[`performance`];'],
  ])('flags %s', async (_name, code) => {
    expect(await lint(code, 'src/engine/fixture.ts')).toEqual([CLOCK]);
  });

  it('allows relay time', async () => {
    const code =
      'export const isOpen = (relayNow: number, closes: number): boolean => relayNow < closes;';
    expect(await lint(code, 'src/engine/fixture.ts')).toEqual([]);
  });

  it("doesn't apply to the engine's tests", async () => {
    expect(await lint('export const now = Date.now();', 'src/engine/fixture.test.ts')).toEqual([]);
  });
});

describe('INTEGERS_ONLY: src/engine counts in integers', () => {
  const INTEGERS =
    'no-restricted-syntax: src/engine counts in integers only. Compare products; never divide, round or truncate.';
  const OPERATORS = ['/', '**', '|', '&', '^', '<<', '>>', '>>>'];

  it.each(OPERATORS)('flags a %s b', async (operator) => {
    const code = `export const f = (a: number, b: number): number => a ${operator} b;`;
    expect(await lint(code, 'src/engine/fixture.ts')).toEqual([INTEGERS]);
  });

  it.each(OPERATORS)('flags a %s= b', async (operator) => {
    const code = `export function f(a: number, b: number): number { a ${operator}= b; return a; }`;
    expect(await lint(code, 'src/engine/fixture.ts')).toEqual([INTEGERS]);
  });

  it.each([
    ['~a', 'export const f = (a: number): number => ~a;'],
    ...['round', 'floor', 'ceil', 'trunc', 'fround'].map((name) => [
      `Math.${name}`,
      `export const f = (a: number): number => Math.${name}(a);`,
    ]),
    ['a decimal literal', 'export const half = 0.5;'],
    ['a decimal literal with no leading digit', 'export const half = .5;'],
    ['an exponent literal', 'export const big = 1e3;'],
  ])('flags %s', async (_name, code) => {
    expect(await lint(code, 'src/engine/fixture.ts')).toEqual([INTEGERS]);
  });

  it('allows integer arithmetic, comparison and integer literals', async () => {
    const code = [
      'export const passes = (sum: number, voters: number, zeros: number): boolean =>',
      '  sum >= 2 * voters && 10 * zeros < voters;',
      'export const mask = 0x1e + 1_000 - Math.max(3, 4) * (7 % 2);',
    ].join('\n');
    expect(await lint(code, 'src/engine/fixture.ts')).toEqual([]);
  });

  it("doesn't apply to the engine's tests", async () => {
    const code = 'export const half = (a: number): number => a / 2;';
    expect(await lint(code, 'src/engine/fixture.test.ts')).toEqual([]);
  });

  it("doesn't apply outside src/engine", async () => {
    const code = 'export const half = (a: number): number => a / 2;';
    expect(await lint(code, 'src/app/fixture.ts')).toEqual([]);
  });
});

describe('network globals: only src/net talks to the network', () => {
  const NETWORK =
    'Only src/net/ talks to the network (spec §2), so every request can be audited in one place.';
  const GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];

  it.each(GLOBALS)('flags the %s global', async (name) => {
    const code = `export const api: unknown = ${name};`;
    expect(await lint(code, 'src/app/fixture.ts')).toEqual([
      `no-restricted-globals: Unexpected use of '${name}'. ${NETWORK}`,
    ]);
  });

  it.each(
    ['window', 'self', 'globalThis'].flatMap((object) => GLOBALS.map((name) => [object, name])),
  )('flags %s.%s', async (object, name) => {
    const code = `export const api: unknown = ${object}.${name};`;
    expect(await lint(code, 'src/app/fixture.ts')).toEqual([
      `no-restricted-properties: '${object}.${name}' is restricted from being used. ${NETWORK}`,
    ]);
  });

  it.each([
    'src/engine/fixture.ts',
    'src/store/fixture.ts',
    'src/screens/Fixture.tsx',
    'src/fixture.ts',
    'src/app/fixture.test.ts',
    'e2e/fixture.spec.ts',
    'e2e/support/fixture.ts',
  ])('applies in %s', async (filePath) => {
    expect(await lint('export const api: unknown = fetch;', filePath)).toEqual([
      `no-restricted-globals: Unexpected use of 'fetch'. ${NETWORK}`,
    ]);
  });

  it.each(['src/net/fixture.ts', 'src/net/fixture.test.ts', 'e2e/support/connect.ts'])(
    "doesn't apply in %s",
    async (filePath) => {
      const code =
        'export const api: unknown[] = [fetch, WebSocket, globalThis.fetch, window.EventSource];';
      expect(await lint(code, filePath)).toEqual([]);
    },
  );

  it('allows a local binding of the same name', async () => {
    const code = 'export function f(fetch: () => number): number { return fetch(); }';
    expect(await lint(code, 'src/app/fixture.ts')).toEqual([]);
  });
});

describe('messages: visible text comes from src/app/messages.ts', () => {
  const TEXT = 'no-restricted-syntax: Visible text comes from src/app/messages.ts.';
  const component = (jsx: string): string => `export function Fixture() {\n  return ${jsx};\n}`;
  const BAD = [
    ['text', '<p>Hello</p>'],
    ['a string', "<p>{'Hello'}</p>"],
    ['a template', '<p>{`Hello`}</p>'],
    ['a string in a fragment', "<>{'Hello'}</>"],
    ...['aria-label', 'placeholder', 'title', 'alt'].flatMap((name) => [
      [`${name}="…"`, `<span ${name}="Hello" />`],
      [`${name}={'…'}`, `<span ${name}={'Hello'} />`],
      [`${name}={\`…\`}`, `<span ${name}={\`Hello\`} />`],
    ]),
  ];

  describe.each(['src/app/Fixture.tsx', 'src/screens/Fixture.tsx'])('in %s', (filePath) => {
    it.each(BAD)('flags %s', async (_name, jsx) => {
      expect(await lint(component(jsx), filePath)).toEqual([TEXT]);
    });

    it('allows text passed in, other attributes and layout whitespace', async () => {
      const code = [
        'export function Fixture({ text, label }: { text: string; label: string }) {',
        '  return (',
        '    <p className="note" aria-label={label}>',
        '      {text}{" "}',
        '    </p>',
        '  );',
        '}',
      ].join('\n');
      expect(await lint(code, filePath)).toEqual([]);
    });
  });

  it.each(['src/app/Fixture.test.tsx', 'src/screens/Fixture.test.tsx', 'src/test/Fixture.tsx'])(
    "doesn't apply in %s",
    async (filePath) => {
      expect(await lint(component('<p aria-label="Hello">Hello</p>'), filePath)).toEqual([]);
    },
  );
});

describe('NO_RAW_HTML: nothing in src/ is ever parsed as HTML', () => {
  const RAW =
    'no-restricted-syntax: Nothing in src/ is parsed as HTML (#70). Build React elements; Atom text goes through <AtomText>.';
  const BAD = [
    [
      'dangerouslySetInnerHTML in JSX',
      'export const f = (h: string) => <div dangerouslySetInnerHTML={{ __html: h }} />;',
    ],
    [
      'dangerouslySetInnerHTML as a prop key',
      "export const props = { dangerouslySetInnerHTML: { __html: '' } };",
    ],
    [
      'dangerouslySetInnerHTML as a quoted key',
      "export const props = { 'dangerouslySetInnerHTML': { __html: '' } };",
    ],
    [
      'dangerouslySetInnerHTML set on an object',
      'export function f(p: Record<string, unknown>) { p.dangerouslySetInnerHTML = {}; }',
    ],
    ['an innerHTML write', 'export function f(e: HTMLElement, h: string) { e.innerHTML = h; }'],
    ['an innerHTML append', 'export function f(e: HTMLElement, h: string) { e.innerHTML += h; }'],
    ['an outerHTML write', 'export function f(e: HTMLElement, h: string) { e.outerHTML = h; }'],
    [
      'insertAdjacentHTML',
      "export function f(e: HTMLElement, h: string) { e.insertAdjacentHTML('beforeend', h); }",
    ],
    ['document.write', 'export function f(h: string) { document.write(h); }'],
    [
      'createContextualFragment',
      'export function f(r: Range, h: string) { return r.createContextualFragment(h); }',
    ],
  ];

  describe.each([
    'src/app/text/Fixture.tsx',
    'src/screens/Fixture.tsx',
    'src/engine/fixture.tsx',
    'src/store/fixture.tsx',
    'src/fixture.tsx',
    'src/app/Fixture.test.tsx',
    'src/engine/fixture.test.tsx',
  ])('in %s', (filePath) => {
    it.each(BAD)('flags %s', async (_name, code) => {
      expect(await lint(code, filePath)).toEqual([RAW]);
    });
  });

  it('allows reading innerHTML, as a test may', async () => {
    const code = 'export const read = (e: HTMLElement): string => e.innerHTML;';
    expect(await lint(code, 'src/app/Fixture.test.tsx')).toEqual([]);
  });

  it('keeps the engine’s own rules beside it', async () => {
    const code =
      'export const f = (e: { innerHTML: string }, a: number) => { e.innerHTML = String(a / 2); };';
    expect(await lint(code, 'src/engine/fixture.ts')).toEqual([
      RAW,
      'no-restricted-syntax: src/engine counts in integers only. Compare products; never divide, round or truncate.',
    ]);
  });

  it('keeps the messages rule beside it', async () => {
    const code =
      'export const f = (h: string) => <p dangerouslySetInnerHTML={{ __html: h }}>Hi</p>;';
    expect(await lint(code, 'src/screens/Fixture.tsx')).toEqual([
      RAW,
      'no-restricted-syntax: Visible text comes from src/app/messages.ts.',
    ]);
  });
});

describe('navigator.credentials: only src/platform/webauthn.ts reaches WebAuthn (#95)', () => {
  const CREDENTIALS =
    "no-restricted-properties: 'navigator.credentials' is restricted from being used. Only src/platform/webauthn.ts reaches WebAuthn (#95), so every passkey request can be audited in one place.";

  it.each([
    ['a call', 'export const ask = () => navigator.credentials.get({});'],
    ['a read', 'export const calls: unknown = navigator.credentials;'],
    ['a computed key', "export const calls: unknown = navigator['credentials'];"],
    ['destructuring', 'export const { credentials } = navigator;'],
  ])('flags %s', async (_name, code) => {
    expect(await lint(code, 'src/app/fixture.ts')).toEqual([CREDENTIALS]);
  });

  it.each([
    'src/app/Fixture.tsx',
    'src/screens/Fixture.tsx',
    'src/store/fixture.ts',
    'src/platform/fixture.ts',
    'src/platform/webauthn.test.ts',
    'src/net/fixture.ts',
    'e2e/fixture.spec.ts',
    'e2e/support/connect.ts',
  ])('applies in %s', async (filePath) => {
    expect(await lint('export const calls: unknown = navigator.credentials;', filePath)).toEqual([
      CREDENTIALS,
    ]);
  });

  it('doesn’t apply in src/platform/webauthn.ts, which still may not reach the network', async () => {
    const code = 'export const calls: unknown[] = [navigator.credentials, window.fetch];';
    expect(await lint(code, 'src/platform/webauthn.ts')).toEqual([
      "no-restricted-properties: 'window.fetch' is restricted from being used. Only src/net/ talks to the network (spec §2), so every request can be audited in one place.",
    ]);
  });

  it('keeps the network rules beside it everywhere else', async () => {
    const code = 'export const both: unknown[] = [navigator.credentials, globalThis.fetch];';
    expect(await lint(code, 'src/app/fixture.ts')).toEqual([
      CREDENTIALS,
      "no-restricted-properties: 'globalThis.fetch' is restricted from being used. Only src/net/ talks to the network (spec §2), so every request can be audited in one place.",
    ]);
  });

  it('allows another object’s credentials field', async () => {
    const code = 'export const mode = (init: RequestInit): unknown => init.credentials;';
    expect(await lint(code, 'src/app/fixture.ts')).toEqual([]);
  });
});
