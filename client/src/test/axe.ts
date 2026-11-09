/**
 * axe-core for component tests (ADR-0055: WCAG 2.2 AA, checked automatically).
 *
 * Runs on the whole rendered document, so page-level rules (one `main`, one
 * `h1`, content inside landmarks) apply too. jsdom lays nothing out, so it
 * can't measure contrast: that rule is off here, and #67 runs axe in real
 * browsers in both themes.
 */
import axe from 'axe-core';

/** The rule sets a screen must pass: WCAG 2.0–2.2 A and AA, plus axe's best practices. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** Every axe violation on the current document, one readable line per rule. */
export async function axeViolations(): Promise<string[]> {
  const results = await axe.run(document, {
    runOnly: { type: 'tag', values: TAGS },
    rules: { 'color-contrast': { enabled: false } },
  });
  return results.violations.map((violation) => {
    const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ');
    return `${violation.id}: ${violation.help} (${targets})`;
  });
}
