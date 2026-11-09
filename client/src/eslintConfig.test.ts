/**
 * Regression tests for the rules eslint.config.js adds itself (#162): NO_CLOCK and
 * INTEGERS_ONLY in src/engine, the network globals outside src/net, and the messages
 * rule in src/app and src/screens. Each must fire on a bad snippet where it applies,
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
  ])('applies in %s', async (filePath) => {
    expect(await lint('export const api: unknown = fetch;', filePath)).toEqual([
      `no-restricted-globals: Unexpected use of 'fetch'. ${NETWORK}`,
    ]);
  });

  it.each(['src/net/fixture.ts', 'src/net/fixture.test.ts'])(
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
