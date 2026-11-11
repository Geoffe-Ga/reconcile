/**
 * What the end-to-end specs share: a fresh run of the real relay for each
 * test (`relay.ts`), a fixture that opens one browser profile per person
 * under the deploy CSP and fails the test on any CSP violation in any of
 * them, axe on the screen a person is looking at, a few locators, and
 * first run's steps (#76). Every profile's requests to Discord are answered
 * by the fixture itself, as a forum channel's webhook would answer them, and
 * kept in `discord` (#119, #123), so no test ever posts to Discord. WebKit
 * never lets `context.route` see a request from a page under the app's
 * service worker, so the fixture fails a test on any request to Discord it
 * didn't answer, and specs move a page with `visit`, which never reloads it
 * into the worker's hands (#123).
 */
import AxeBuilder from '@axe-core/playwright';
import {
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  type Request,
  type Route,
  test as base,
} from '@playwright/test';

import { type RunningRelay, startRelay } from './relay';

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

/** One request a page sent to Discord, which the fixture answered as Discord answers a post. */
export interface DiscordRequest {
  readonly method: string;
  readonly url: string;
  /** Its headers, as the browser sent them. */
  readonly headers: Readonly<Record<string, string>>;
  /** Its body read as JSON, or null for none. */
  readonly body: unknown;
}

/** True for a URL on a Discord host: discord.com, discordapp.com, or any name under them. */
export function isDiscord(url: URL): boolean {
  return /(^|\.)(discord|discordapp)\.com$/.test(url.hostname);
}

/** The server the fixture's webhook belongs to (#123). */
export const DISCORD_GUILD = '1188000000000000001';

/** The forum channel the fixture's webhook belongs to (#123). */
export const DISCORD_FORUM = '1199000000000000777';

/** The id of the `index`th thread the fixture opens, counting from 0 (#123). */
export function discordThread(index: number): string {
  return `13090000000000000${String(index + 10)}`;
}

/** What the fixture's Discord has opened: how many threads so far. */
interface Forum {
  threads: number;
}

/**
 * Discord's answer to a request, as a forum channel's webhook gives it (#123):
 * a GET of the webhook names its server and channel; a post with
 * `thread_name` opens a new thread and, with `?wait=true`, answers its
 * message, whose `channel_id` is the thread; any other post answers 204. A
 * Join discussion link (`/channels/…`) opens a plain page.
 */
function discordAnswer(url: URL, method: string, body: unknown, forum: Forum) {
  const cors = { 'access-control-allow-origin': '*' };
  const json = (value: unknown) => ({
    status: 200,
    headers: { ...cors, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (url.pathname.startsWith('/channels/')) {
    return {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<title>Discord</title>',
    };
  }
  if (method === 'GET') {
    return json({ id: '1199000000000000001', guild_id: DISCORD_GUILD, channel_id: DISCORD_FORUM });
  }
  const opens = typeof body === 'object' && body !== null && 'thread_name' in body;
  const channel = opens ? discordThread(forum.threads++) : DISCORD_FORUM;
  if (url.searchParams.get('wait') !== 'true') return { status: 204, headers: cors };
  return json({ id: '1400000000000000001', type: 0, channel_id: channel });
}

/** Answers a request to Discord as a forum channel's webhook does, keeping it; a CORS preflight gets its own answer. */
async function answerAsDiscord(
  route: Route,
  requests: DiscordRequest[],
  forum: Forum,
): Promise<void> {
  const request = route.request();
  const cors = { 'access-control-allow-origin': '*' };
  if (request.method() === 'OPTIONS') {
    await route.fulfill({
      status: 204,
      headers: {
        ...cors,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
      },
    });
    return;
  }
  const text = request.postData();
  const body = text === null ? null : (JSON.parse(text) as unknown);
  requests.push({
    method: request.method(),
    url: request.url(),
    headers: await request.allHeaders(),
    body,
  });
  await route.fulfill(discordAnswer(new URL(request.url()), request.method(), body, forum));
}

/** What a context sent to Discord that the fixture didn't answer (#123). */
export interface DiscordWatch {
  /** Each request the browser sent to Discord that the fixture never answered, as `METHOD url`. */
  unanswered(): string[];
}

/**
 * Answers every request `context` makes to Discord itself, as a forum
 * channel's webhook would, keeping each in `requests`. Profiles routed with
 * one `forum` share its threads, as members of one group share its channel.
 *
 * The watch it returns names any request to Discord the browser sent that
 * the route never saw, such as one from a page under the app's service
 * worker in WebKit (#123). A CORS preflight is the browser's, not the app's,
 * so it isn't counted.
 */
export async function routeDiscord(
  context: BrowserContext,
  requests: DiscordRequest[],
  forum: Forum = { threads: 0 },
): Promise<DiscordWatch> {
  const sent: Request[] = [];
  const answered = new Set<Request>();
  context.on('request', (request) => {
    if (request.method() !== 'OPTIONS' && isDiscord(new URL(request.url()))) sent.push(request);
  });
  await context.route(isDiscord, (route) => {
    answered.add(route.request());
    return answerAsDiscord(route, requests, forum);
  });
  return {
    unanswered: () =>
      sent
        .filter((request) => !answered.has(request))
        .map((request) => `${request.method()} ${request.url()}`),
  };
}

/**
 * Opens a new profile for `name`; the fixture closes it after the test.
 * `discord` holds every request any profile sent to Discord, in order (#119),
 * and the test fails on any request to Discord the fixture didn't answer (#123).
 */
export interface OpenProfile {
  (name: string, options?: BrowserContextOptions): Promise<Person>;
  readonly discord: readonly DiscordRequest[];
}

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

/**
 * Playwright's `test`, with the relay started before each test and stopped after
 * it, and `openProfile`: each profile it opens is checked for CSP violations
 * and for requests to Discord that the fixture didn't answer.
 */
export const test = base.extend<{ relay: RunningRelay; openProfile: OpenProfile }>({
  // Every test gets the relay, started before it and stopped after it. It waits for
  // the relay's health check through `request`.
  relay: [
    async ({ request }, provide) => {
      const relay = await startRelay(request);
      try {
        await provide(relay);
      } finally {
        await relay.stop();
      }
    },
    { auto: true },
  ],
  openProfile: async ({ browser }, provide) => {
    const profiles: { readonly person: Person; readonly violations: string[] }[] = [];
    const discord: DiscordRequest[] = [];
    const forum: Forum = { threads: 0 };
    const watches: DiscordWatch[] = [];
    const open = async (name: string, options: BrowserContextOptions = {}): Promise<Person> => {
      // The project's `use` options (baseURL, device) apply; the CSP always does.
      const context = await browser.newContext({ ...options, bypassCSP: false });
      watches.push(await routeDiscord(context, discord, forum));
      const violations: string[] = [];
      await context.exposeFunction(REPORT_VIOLATION, (line: string) => {
        violations.push(line);
      });
      await context.addInitScript(recordCspViolations, REPORT_VIOLATION);
      const person = { name, page: await context.newPage() };
      profiles.push({ person, violations });
      return person;
    };
    await provide(Object.assign(open, { discord }));
    try {
      // A round trip through each page lets any queued violation report arrive.
      for (const { person } of profiles) await person.page.evaluate(() => undefined);
      const all = profiles.flatMap(({ person, violations }) =>
        violations.map((line) => `${person.name}: ${line}`),
      );
      expect(all, 'CSP violations').toEqual([]);
      const unanswered = watches.flatMap((watch) => watch.unanswered());
      expect(unanswered, 'requests to Discord that the fixture never answered').toEqual([]);
    } finally {
      await Promise.all(profiles.map(({ person }) => person.page.context().close()));
    }
  },
});

/**
 * Shows `url` on `page`, navigating only when the page isn't there already
 * (#123). WebKit reloads a page sent to its own URL, where Chromium stays
 * put, and the reloaded page comes under the app's service worker, whose
 * requests WebKit never lets `context.route` see.
 */
export async function visit(page: Page, url: string): Promise<void> {
  if (page.url() !== url) await page.goto(url);
}

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

/**
 * The `localStorage` key of the first-run guide's flag (`src/platform/guide.ts`,
 * #91). The specs reach the app only from outside, so they spell it here.
 */
export const GUIDE_KEY = 'reconcile.first-run-guide';

/**
 * The `localStorage` key of the passkey offer's answer (`src/platform/passkeyOffer.ts`,
 * #95), spelled here for the same reason.
 */
export const PASSKEY_OFFER_KEY = 'reconcile.passkey-offer';

/** The passkey offer's heading (#95). */
export const PASSKEY_OFFER = 'Lock your keys with a passkey';

/** What first run leaves for later in a profile. */
export interface FirstRunOptions {
  /** True to meet the first-run guide (#91) after the profile's first create or join. */
  readonly guide?: boolean;
  /** True to stop at the passkey offer (#95), which the profile otherwise answers Not now. */
  readonly passkey?: boolean;
}

/** What first run showed a profile. */
export interface FirstRun {
  /** Whether the passkey offer (#95) followed the notice. */
  readonly passkeyOffered: boolean;
}

/**
 * First run (#76): a new profile's pilot notice, checked by axe, then
 * accepted. Where the browser can lock keys with a passkey, the passkey
 * offer follows (#95): unless `passkey` is true, it is checked by axe and
 * answered Not now, so a spec about something else goes on to the app.
 * Unless `guide` is true, the profile then counts the first-run guide (#91)
 * as seen, as its Skip leaves it, so a spec about something else isn't
 * stopped by the guide's dialog after its first create or join.
 */
export async function acceptNotice(
  person: Person,
  options: FirstRunOptions = {},
): Promise<FirstRun> {
  const { page } = person;
  await expect(heading(page, 'Before you start')).toBeVisible();
  await expectAccessible(person, 'Pilot notice');
  await page.getByRole('button', { name: 'I understand' }).click();
  await expect(heading(page, 'Before you start')).toBeHidden();
  // The offer renders in the same commit that takes the notice away, so this reads it once.
  const offer = heading(page, PASSKEY_OFFER);
  const passkeyOffered = await offer.isVisible();
  if (passkeyOffered && options.passkey !== true) {
    await expectAccessible(person, 'Passkey offer');
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(offer).toBeHidden();
  }
  if (options.guide !== true) {
    await page.evaluate((key) => {
      window.localStorage.setItem(key, '1');
    }, GUIDE_KEY);
  }
  return { passkeyOffered };
}

/** The keys in the origin's `localStorage` on `page`, sorted. */
export function localKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(window.localStorage).sort());
}

/** A group to found: its name, its Document's title and sections, and the founder's name. */
export interface NewGroup {
  readonly name: string;
  readonly title: string;
  readonly atoms: readonly string[];
  readonly founder: string;
}

/**
 * From Start, founds `group`, waits for Group home (its genesis is back from
 * the relay), presses Copy invite link, and returns the link it made (#73).
 */
export async function foundGroup(page: Page, group: NewGroup): Promise<string> {
  await page.getByRole('link', { name: 'Create group' }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill(group.name);
  await page.getByRole('textbox', { name: 'Your name' }).fill(group.founder);
  await page.getByRole('textbox', { name: 'Document title' }).fill(group.title);
  await page.getByRole('textbox', { name: 'Document text' }).fill(group.atoms.join('\n\n'));
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(heading(page, group.name)).toBeVisible();
  await page.getByRole('button', { name: 'Copy invite link' }).click();
  const link = page.getByRole('textbox', { name: 'Invite link' });
  await expect(link).toHaveValue(/#join\/[\w-]{43}$/);
  return link.inputValue();
}

/** The number of records in every IndexedDB database the page's origin holds. */
export async function storedRecords(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const settle = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(new Error('IndexedDB refused the read.'));
        };
      });
    let records = 0;
    for (const { name } of await indexedDB.databases()) {
      if (name === undefined) continue;
      const db = await settle(indexedDB.open(name));
      for (const store of db.objectStoreNames) {
        records += await settle(db.transaction(store).objectStore(store).count());
      }
      db.close();
    }
    return records;
  });
}
