import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** The engine reads no clock: votes run on relay time, so every device folds alike (spec §4). */
const NO_CLOCK = ['Date', 'performance'].map((name) => ({
  selector: `Identifier[name='${name}']`,
  message: 'src/engine reads no clock. Use relay time (`received`, `relayNow`).',
}));

/** The tally uses integers only: no floats, division or rounding (spec §5). */
const INTEGERS_ONLY = [
  "BinaryExpression[operator='/']",
  "AssignmentExpression[operator='/=']",
  "MemberExpression[object.name='Math'][property.name=/^(round|floor|ceil|trunc|fround)$/]",
  'Literal[raw=/^[0-9_]*[.eE]/]',
].map((selector) => ({ selector, message: 'The tally uses integers only: compare products.' }));

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
    files: ['src/engine/**/*.ts'],
    ignores: ['src/engine/**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...NO_CLOCK] },
  },
  {
    // A later block replaces a rule's options rather than merging them, so repeat NO_CLOCK.
    files: ['src/engine/tally.ts'],
    rules: { 'no-restricted-syntax': ['error', ...NO_CLOCK, ...INTEGERS_ONLY] },
  },
  { files: ['eslint.config.js'], extends: [tseslint.configs.disableTypeChecked] },
);
