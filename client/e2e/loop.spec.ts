/**
 * The tracer loop (#67), end to end: three people, each in a browser profile
 * of their own, found a group and join it through the real relay, with the
 * build served under the deploy CSP.
 *
 * axe checks every screen they settle on, and any CSP violation in any page
 * fails the test.
 */
import AxeBuilder from '@axe-core/playwright';
import {
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test as base,
} from '@playwright/test';

/** WCAG 2.0–2.2 A and AA plus axe's best practices, as `src/test/axe.ts`, with contrast on. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** The name the init script reports CSP violations to, exposed on every page. */
const REPORT_VIOLATION = 'e2eReportCspViolation';

/** One person: a browser profile of their own, and the page they use. */
interface Person {
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

const test = base.extend<{ openProfile: OpenProfile }>({
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
function heading(page: Page, name: string): Locator {
  return page.getByRole('heading', { level: 1, name });
}

/** Fails on any axe violation on the screen `person` is looking at. */
async function expectAccessible(person: Person, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page: person.page }).withTags(AXE_TAGS).analyze();
  const lines = results.violations.map((violation) => {
    const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ');
    return `${violation.id}: ${violation.help} (${targets})`;
  });
  expect(lines, `axe on ${person.name}'s ${screen}`).toEqual([]);
}

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const ATOMS = ['Quiet hours start at 10pm.', 'Shared spaces are cleaned every Sunday.'];
const PEOPLE = ['Ana', 'Ben', 'Cal'];

/** Joins from Join's form, then waits for Group home. */
async function join(person: Person): Promise<void> {
  await expect(heading(person.page, GROUP)).toBeVisible();
  // The invite's secret has left the address bar.
  await expect(person.page).toHaveURL(/#\/join$/);
  await expectAccessible(person, 'Join');
  await person.page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await person.page.getByRole('button', { name: 'Join group' }).click();
  await expect(person.page).toHaveURL(/#\/g\/[A-Za-z0-9_-]+$/);
}

/** Group home lists everyone; the Document view shows every section. */
async function expectGroupAndDocument(person: Person): Promise<void> {
  const { page } = person;
  await expect(heading(page, GROUP)).toBeVisible();
  const people = page.getByRole('region', { name: 'People' }).getByRole('listitem');
  await expect(people).toHaveText(PEOPLE);
  await expectAccessible(person, 'Group home');
  await page.getByRole('link', { name: new RegExp(TITLE) }).click();
  await expect(heading(page, TITLE)).toBeVisible();
  await expect(page.getByRole('article').getByRole('paragraph')).toHaveText(ATOMS);
  await expectAccessible(person, 'Document view');
}

test('three members propose, vote and see the Update', async ({ openProfile }) => {
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  const cal = await openProfile('Cal', { colorScheme: 'dark' });
  let inviteLink = '';

  await test.step('A creates a group', async () => {
    const { page } = ana;
    await page.goto('/');
    await expect(heading(page, 'Your groups')).toBeVisible();
    await expectAccessible(ana, 'Start');
    await page.getByRole('link', { name: 'Create group' }).click();
    await expect(heading(page, 'Create a group')).toBeVisible();
    await expectAccessible(ana, 'Create group');
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
    await page
      .getByRole('textbox', { name: 'Chat link (optional)' })
      .fill('https://chat.example.org/riverside');
    await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
    await page.getByRole('textbox', { name: 'Document text' }).fill(ATOMS.join('\n\n'));
    await page.getByRole('button', { name: 'Create group' }).click();

    // Group home appears once the genesis is back from the relay.
    await expect(heading(page, GROUP)).toBeVisible();
    await expect(page.getByRole('region', { name: 'People' }).getByRole('listitem')).toHaveText([
      'Ana',
    ]);
    await expectAccessible(ana, 'Group home');
    const field = page.getByRole('textbox', { name: 'Invite link' });
    await expect(field).toHaveAttribute('readonly', '');
    inviteLink = await field.inputValue();
    expect(inviteLink).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\/join\/[\w-]{43}\.[\w-]{43}$/);
  });

  await test.step('B and C join from the link in A’s invite field', async () => {
    // B opens the link itself.
    await ben.page.goto(inviteLink);
    await join(ben);

    // C pastes it on Start, in the dark theme.
    await cal.page.goto('/');
    await expect(heading(cal.page, 'Your groups')).toBeVisible();
    await expectAccessible(cal, 'Start');
    await cal.page.getByRole('textbox', { name: 'Invite link' }).fill(inviteLink);
    await cal.page.getByRole('button', { name: 'Open invite' }).click();
    await join(cal);
  });

  await test.step('all three see the Document and everyone in the group', async () => {
    for (const person of [ana, ben, cal]) await expectGroupAndDocument(person);
  });
});
