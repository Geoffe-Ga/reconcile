/**
 * What a profile's pages ever showed (#127): an init script watches every
 * page in the profile from its first paint, and reports each of a few
 * needles the first time it appears anywhere in the page's markup, its text
 * and attributes alike. A spec checks that something never reached a
 * person's screen, at any moment in the run, rather than only on the screens
 * it stops to read. Give it a needle the profile is sure to show too, as a
 * control, so the watch can't pass by seeing nothing.
 */
import type { Person } from './fixtures';

/** The name the init script reports to, exposed on every page of the profile. */
const REPORT_SEEN = 'e2eReportSeen';

/** The needles a profile's pages have shown. */
export interface Watch {
  /** Each needle any page in the profile has shown so far, in the order they first appeared. */
  seen(): Promise<readonly string[]>;
}

/**
 * Runs in every page before the app: once the document has loaded, and on
 * each change to it, looks for each needle not yet seen in its markup and
 * reports it. Playwright serializes it into the page, so it reads nothing
 * else.
 */
function reportNeedles({ report, needles }: { report: string; needles: string[] }): void {
  const seen = new Set<string>();
  const look = () => {
    const markup = document.documentElement.outerHTML;
    for (const needle of needles) {
      if (seen.has(needle) || !markup.includes(needle)) continue;
      seen.add(needle);
      const send = Reflect.get(window, report) as (needle: string) => Promise<void>;
      void send(needle);
    }
  };
  new MutationObserver(look).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  // The markup the page arrives with, before anything changes it.
  document.addEventListener('DOMContentLoaded', look);
}

/** Watches every page in `person`'s profile, from its next navigation on, for each of `needles`. */
export async function watchFor(person: Person, needles: readonly string[]): Promise<Watch> {
  const { page } = person;
  const context = page.context();
  const seen: string[] = [];
  await context.exposeFunction(REPORT_SEEN, (needle: string) => {
    if (!seen.includes(needle)) seen.push(needle);
  });
  await context.addInitScript(reportNeedles, { report: REPORT_SEEN, needles: [...needles] });
  return {
    async seen() {
      // A round trip through the page lets any report already sent arrive.
      await page.evaluate(() => undefined);
      return [...seen];
    },
  };
}
