/**
 * What the end-to-end specs share: a fixture that opens one browser profile
 * per person under the deploy CSP and fails the test on any CSP violation in
 * any of them, axe on the screen a person is looking at, and a few locators.
 */
import AxeBuilder from '@axe-core/playwright';
import {
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test as base,
} from '@playwright/test';

export { expect };

/** WCAG 2.0–2.2 A and AA plus axe's best practices, as `src/test/axe.ts`, with contrast on. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** The name the init script reports CSP violations to, exposed on every page. */
const REPORT_VIOLATION = 'e2eReportCspViolation';

/** One person: a browser profile of their own, and the page they use. */
export interface Person {
  readonly name: string;
  readonly page: Page;
}

/** Opens a new profile for `name`; the fixture closes it after the test. */
type OpenProfile = (name: string, options?: BrowserContextOptions) => Promise<Person>;

/**
 * Runs in every page before the app: sends each `securitypolicyviolation` to
 * the test. Playwright serializes it into the page, so it reads nothing else.
 */
function recordCspViolations(report: string): void {
  window.addEventListener(
    'securitypolicyviolation',
    (event) => {
      const send = Reflect.get(window, report) as (line: string) => Promise<void>;
      void send(
        `${event.violatedDirective} blocked ${event.blockedURI || 'inline'} (${event.sourceFile})`,
      );
    },
    true,
  );
}

/** Playwright's `test`, with `openProfile`: each profile it opens is checked for CSP violations. */
export const test = base.extend<{ openProfile: OpenProfile }>({
  openProfile: async ({ browser }, provide) => {
    const profiles: { readonly person: Person; readonly violations: string[] }[] = [];
    await provide(async (name, options = {}) => {
      // The project's `use` options (baseURL, device) apply; the CSP always does.
      const context = await browser.newContext({ ...options, bypassCSP: false });
      const violations: string[] = [];
      await context.exposeFunction(REPORT_VIOLATION, (line: string) => {
        violations.push(line);
      });
      await context.addInitScript(recordCspViolations, REPORT_VIOLATION);
      const person = { name, page: await context.newPage() };
      profiles.push({ person, violations });
      return person;
    });
    try {
      // A round trip through each page lets any queued violation report arrive.
      for (const { person } of profiles) await person.page.evaluate(() => undefined);
      const all = profiles.flatMap(({ person, violations }) =>
        violations.map((line) => `${person.name}: ${line}`),
      );
      expect(all, 'CSP violations').toEqual([]);
    } finally {
      await Promise.all(profiles.map(({ person }) => person.page.context().close()));
    }
  },
});

/** The screen's one `h1`. */
export function heading(page: Page, name: string): Locator {
  return page.getByRole('heading', { level: 1, name });
}

/** Fails on any axe violation on the screen `person` is looking at. */
export async function expectAccessible(person: Person, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page: person.page }).withTags(AXE_TAGS).analyze();
  const lines = results.violations.map((violation) => {
    const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ');
    return `${violation.id}: ${violation.help} (${targets})`;
  });
  expect(lines, `axe on ${person.name}'s ${screen}`).toEqual([]);
}

/**
 * Presses the React Aria radio `name`, inside `within` when given: React Aria
 * hides the native input under its label, so this presses the label.
 */
export async function pick(page: Page, name: string, within?: Locator): Promise<void> {
  const scope = within ?? page;
  const radio = scope.getByRole('radio', { name });
  // `has` is matched inside each label, so it names the radio from the page, not the scope.
  await scope.locator('label', { has: page.getByRole('radio', { name }) }).click();
  await expect(radio).toBeChecked();
}
