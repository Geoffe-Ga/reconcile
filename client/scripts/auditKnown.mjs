/**
 * Checks a whole `npm audit --json` report, read on stdin, against the
 * client's known list (#495; the cve-remediation skill's last resort).
 *
 * `audit.sh` has already failed on any advisory in a production dependency,
 * which never gets an exception. What's left is dev tooling: every advisory
 * at moderate or worse must be on `.npm-audit-known-vulnerabilities`, with
 * an `expires=YYYY-MM-DD` date that hasn't passed and is at most 30 days
 * from today, and a `#` comment naming the package, why, and the tracking
 * issue. The tool enforces the review date, so no exception outlives it.
 *
 * Usage: node auditKnown.mjs <known-list-path> < report.json
 * `AUDIT_TODAY` (YYYY-MM-DD) stands in for today in tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

/** The severities the gate fails on: moderate or worse, as `--audit-level=moderate`. */
const COUNTED = new Set(['moderate', 'high', 'critical']);

/** The longest an exception may run before someone looks again. */
const MAX_DAYS = 30;

/** A list line: an advisory id, its expiry, and a comment. */
const LINE = /^(GHSA(?:-[0-9a-z]{4}){3})\s+expires=(\d{4}-\d{2}-\d{2})\s+#\s*\S/u;

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The known list as advisory id → expiry, or the problems with it. */
function readKnown(path) {
  const known = new Map();
  const problems = [];
  if (!existsSync(path)) return { known, problems };
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) return;
      const match = LINE.exec(line);
      if (match === null || Number.isNaN(Date.parse(`${match[2]}T00:00:00Z`))) {
        problems.push(
          `.npm-audit-known-vulnerabilities line ${String(index + 1)} needs "GHSA-…  expires=YYYY-MM-DD  # package - reason - tracking #N": ${line}`,
        );
        return;
      }
      known.set(match[1], match[2]);
    });
  return { known, problems };
}

/** Every advisory at moderate or worse in `report`, by GHSA id, with its title. */
function advisoriesIn(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== 'object' || !COUNTED.has(via.severity)) continue;
      const id = /GHSA(?:-[0-9a-z]{4}){3}/u.exec(via.url ?? '')?.[0] ?? via.url ?? String(via.source);
      found.set(id, `${via.name ?? '?'}: ${via.title ?? ''}`);
    }
  }
  return found;
}

/** What `report` and `known` say, as lines to print and whether the gate passes. */
function check(report, { known, problems }, today) {
  const failures = [...problems];
  const notes = [];
  for (const [id, title] of advisoriesIn(report)) {
    const expires = known.get(id);
    if (expires === undefined) failures.push(`${id} (${title}) is not on the known list.`);
    else if (expires < today) failures.push(`${id} expired on ${expires}: look again (see its tracking issue).`);
    else if (daysBetween(today, expires) > MAX_DAYS)
      failures.push(`${id} expires ${expires}, more than ${String(MAX_DAYS)} days out.`);
    else notes.push(`Known, dev tooling only, until ${expires}: ${id} (${title})`);
  }
  const reported = advisoriesIn(report);
  for (const id of known.keys()) {
    if (!reported.has(id)) notes.push(`${id} is no longer reported: remove it from the list.`);
  }
  return { failures, notes };
}

const [listPath] = process.argv.slice(2);
const today = process.env.AUDIT_TODAY ?? new Date().toISOString().slice(0, 10);
const { failures, notes } = check(JSON.parse(readFileSync(0, 'utf8')), readKnown(listPath ?? ''), today);
for (const note of notes) console.log(note);
for (const failure of failures) console.error(`✗ ${failure}`);
process.exitCode = failures.length === 0 ? 0 : 1;
