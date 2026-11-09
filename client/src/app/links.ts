/**
 * Outside links a group writes, such as its chat link (ADR-0011).
 *
 * A link from the group log is untrusted text. Only absolute `http:` and
 * `https:` links render, so a `javascript:` or `data:` link never reaches an
 * `href` (spec §8, Create group).
 */

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** The parsed `href` of an absolute `http:` or `https:` link, or null for anything else. */
export function httpLink(text: string): string | null {
  let url: URL;
  try {
    // No base: a relative link is refused rather than resolved against the app.
    url = new URL(text);
  } catch {
    return null;
  }
  return WEB_PROTOCOLS.has(url.protocol) ? url.href : null;
}

/** True for an absolute `http:` or `https:` link. */
export function isHttpLink(text: string): boolean {
  return httpLink(text) !== null;
}
