import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The engine reads no clock: votes run on relay time, so every device folds alike (spec §4).
 * A computed key, as a string or a plain template (`globalThis['Date']`), reaches the clock
 * as surely as the name does.
 */
const NO_CLOCK = ['Date', 'performance']
  .flatMap((name) => [
    `Identifier[name='${name}']`,
    `MemberExpression > Literal.property[value='${name}']`,
    `MemberExpression > TemplateLiteral.property[expressions.length=0][quasis.0.value.cooked='${name}']`,
  ])
  .map((selector) => ({
    selector,
    message: 'src/engine reads no clock. Use relay time (`received`, `relayNow`).',
  }));

/**
 * Operators that can leave the integers: division and powers make fractions, and the
 * bitwise ones truncate to 32 bits (`x | 0`, `x >>> 0`), which hides a fraction.
 */
const NON_INTEGER_OPERATORS = ['/', '**', '|', '&', '^', '<<', '>>', '>>>'];

/** The engine counts in integers only: no floats, division, powers or rounding (spec §5). */
const INTEGERS_ONLY = [
  ...NON_INTEGER_OPERATORS.flatMap((operator) => [
    `BinaryExpression[operator='${operator}']`,
    `AssignmentExpression[operator='${operator}=']`,
  ]),
  "UnaryExpression[operator='~']",
  "MemberExpression[object.name='Math'][property.name=/^(round|floor|ceil|trunc|fround)$/]",
  'Literal[raw=/^[0-9_]*[.eE]/]',
].map((selector) => ({
  selector,
  message: 'src/engine counts in integers only. Compare products; never divide, round or truncate.',
}));

/**
 * Nothing in src/ is ever parsed as HTML (#70, spec §9): Atom text and every other group
 * word reach the page only as React elements and escaped text. These are the sinks that
 * would parse a string as markup.
 */
const RAW_HTML_SINKS = /^(innerHTML|outerHTML)$/;
const NO_RAW_HTML = [
  "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  "Property[key.name='dangerouslySetInnerHTML']",
  "Property[key.value='dangerouslySetInnerHTML']",
  "MemberExpression[property.name='dangerouslySetInnerHTML']",
  `AssignmentExpression > MemberExpression.left[property.name=${String(RAW_HTML_SINKS)}]`,
  'CallExpression > MemberExpression.callee[property.name=/^(insertAdjacentHTML|createContextualFragment)$/]',
  "CallExpression > MemberExpression.callee[object.name='document'][property.name=/^(write|writeln)$/]",
].map((selector) => ({
  selector,
  message:
    'Nothing in src/ is parsed as HTML (#70). Build React elements; Atom text goes through <AtomText>.',
}));

/** The browser's ways to reach the network. Only src/net/ may use them (spec §2). */
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
const NETWORK_MESSAGE =
  'Only src/net/ talks to the network (spec §2), so every request can be audited in one place.';

/** Each network global's restricted reads through `window`, `self` and `globalThis`. */
const NETWORK_PROPERTIES = ['window', 'self', 'globalThis'].flatMap((object) =>
  NETWORK_GLOBALS.map((property) => ({ object, property, message: NETWORK_MESSAGE })),
);

/**
 * WebAuthn (#95): only src/platform/webauthn.ts reaches `navigator.credentials`, so every
 * passkey request, and so every PRF output, comes from one audited file.
 */
const WEBAUTHN = 'src/platform/webauthn.ts';
const CREDENTIALS_PROPERTIES = [
  {
    object: 'navigator',
    property: 'credentials',
    message:
      'Only src/platform/webauthn.ts reaches WebAuthn (#95), so every passkey request can be audited in one place.',
  },
];

/** Every visible string comes from src/app/messages.ts (spec §2, ADR-0055), so none escapes it. */
const TEXT_ATTRIBUTE = 'JSXAttribute[name.name=/^(aria-label|placeholder|title|alt)$/]';
const MESSAGES_ONLY = [
  'JSXText[value=/\\S/]',
  ':matches(JSXElement, JSXFragment) > JSXExpressionContainer > Literal[value=/\\S/]',
  ':matches(JSXElement, JSXFragment) > JSXExpressionContainer > TemplateLiteral',
  `${TEXT_ATTRIBUTE} > Literal`,
  `${TEXT_ATTRIBUTE} > JSXExpressionContainer > :matches(Literal, TemplateLiteral)`,
].map((selector) => ({ selector, message: 'Visible text comes from src/app/messages.ts.' }));

/**
 * No press starts on a disabled submit button (#193). React Aria's usePress starts one on
 * pointerdown even while a button is disabled, and clicks the button itself 80 ms on; if
 * the form's action ended by then, that click submits again. So a submit Button with
 * `isDisabled` needs `onPointerDownCapture={holdPresses(…)}` on it or on a parent in the
 * same JSX (src/app/holdPresses.ts). A plain button is safe: no `onPress` runs for a press
 * that started while disabled.
 */
const HOLDS_PRESSES =
  "JSXAttribute[name.name='onPointerDownCapture'] > JSXExpressionContainer > CallExpression[callee.name='holdPresses']";
const HELD_SUBMIT = [
  {
    selector: [
      "JSXOpeningElement[name.name='Button']",
      ":has(> JSXAttribute[name.name='type'][value.value='submit'])",
      ":has(> JSXAttribute[name.name='isDisabled'])",
      // esquery takes one `>` step after a relative `:has(> …)`, so the hold nests a second `:has`.
      `:not(:has(${HOLDS_PRESSES}))`,
      `:not(JSXElement:has(> JSXOpeningElement:has(${HOLDS_PRESSES})) *)`,
    ].join(''),
    message:
      'A submit Button that is disabled while its form sends needs holdPresses(…) as onPointerDownCapture on it or on a parent (#193): React Aria clicks a button pressed while disabled itself, 80 ms on, and that click sends the form again once the button is enabled.',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'reports', '.stryker-tmp', 'plans/architecture/*.cjs'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      jsxA11y.flatConfigs.strict,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      complexity: ['error', 10],
    },
  },
  {
    // All of src/, tests included. A later block that sets `no-restricted-syntax` replaces
    // these options for the files it matches rather than merging them, so each such block
    // below lists NO_RAW_HTML again.
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...NO_RAW_HTML] },
  },
  {
    // All of src/engine, not just tally.ts, so a helper the tally imports can't divide for it.
    // Keep this the only later `no-restricted-syntax` block that matches src/engine.
    files: ['src/engine/**/*.ts'],
    ignores: ['src/engine/**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...NO_CLOCK, ...INTEGERS_ONLY, ...NO_RAW_HTML] },
  },
  {
    // Each of the three blocks below sets `no-restricted-properties` for its own files, and
    // none overlap, so no block replaces another's options.
    files: ['**/*.{ts,tsx}'],
    // e2e/support/connect.ts sends requests from inside the page on purpose: e2e/csp.spec.ts
    // proves the deploy CSP lets the page reach only its own origin and Discord's webhooks (#119).
    ignores: ['src/net/**', 'e2e/support/connect.ts', WEBAUTHN],
    rules: {
      'no-restricted-globals': [
        'error',
        ...NETWORK_GLOBALS.map((name) => ({ name, message: NETWORK_MESSAGE })),
      ],
      'no-restricted-properties': ['error', ...NETWORK_PROPERTIES, ...CREDENTIALS_PROPERTIES],
    },
  },
  {
    // The one file that reaches WebAuthn still may not reach the network.
    files: [WEBAUTHN],
    rules: {
      'no-restricted-globals': [
        'error',
        ...NETWORK_GLOBALS.map((name) => ({ name, message: NETWORK_MESSAGE })),
      ],
      'no-restricted-properties': ['error', ...NETWORK_PROPERTIES],
    },
  },
  {
    // The files that reach the network still may not reach WebAuthn.
    files: ['src/net/**/*.{ts,tsx}', 'e2e/support/connect.ts'],
    rules: { 'no-restricted-properties': ['error', ...CREDENTIALS_PROPERTIES] },
  },
  {
    files: ['src/app/**/*.tsx', 'src/screens/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    rules: { 'no-restricted-syntax': ['error', ...MESSAGES_ONLY, ...HELD_SUBMIT, ...NO_RAW_HTML] },
  },
  { files: ['eslint.config.js'], extends: [tseslint.configs.disableTypeChecked] },
);
