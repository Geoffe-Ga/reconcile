#!/usr/bin/env node
/**
 * Writes src/shelf/confusables.ts from Unicode's confusables.txt (UTS #39),
 * pinned to one version and checked against its SHA-256 (#487; ADR-0081;
 * docs/spec/listed-doors.md §4.4).
 *
 * Run from client/:
 *
 *   node scripts/confusables.mjs            # downloads the pinned file
 *   node scripts/confusables.mjs FILE       # reads a copy already downloaded
 *
 * It refuses any file whose SHA-256 isn't the pinned one, so the table can
 * only come from that version's file. It keeps every mapping in the file
 * and nothing else: each source code point and its prototype, sorted by
 * source. The same file always writes the same bytes, which
 * src/shelf/skeleton.test.ts pins by their SHA-256.
 *
 * To move to a new Unicode version: change VERSION and SOURCE_SHA256 here,
 * run it, update the pinned hash in skeleton.test.ts, and check the
 * skeleton vectors still hold.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const VERSION = '18.0.0';
const URL_OF_FILE = `https://www.unicode.org/Public/${VERSION}/security/confusables.txt`;
/** The file's SHA-256, as bytes, as the repo pins every hash and key, so none reads as a secret. */
const SOURCE_SHA256 = Buffer.from([
  110, 211, 238, 150, 124, 157, 253, 246, 103, 125, 86, 60, 153, 133, 24, 47, 188, 80, 162, 239,
  183, 214, 5, 156, 213, 123, 46, 44, 225, 143, 91, 146,
]);
const OUT = new URL('../src/shelf/confusables.ts', import.meta.url);
/** The widest a line of entries runs, so prettier leaves the file as written. */
const LINE_WIDTH = 92;

/** The file's text: from `path` when given, else downloaded from Unicode. */
async function source(path) {
  if (path !== undefined) return readFile(path);
  const response = await fetch(URL_OF_FILE);
  if (!response.ok) throw new Error(`${URL_OF_FILE} answered ${String(response.status)}.`);
  return Buffer.from(await response.arrayBuffer());
}

/** Each mapping in `text`, as [source, prototype code points], sorted by source. */
function mappings(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const data = line.split('#')[0].trim();
    if (data === '') continue;
    const [from, to, type] = data.split(';').map((field) => field.trim());
    if (type !== 'MA') throw new Error(`Unexpected mapping type in: ${line}`);
    entries.push([parseInt(from, 16), to.split(' ').map((hex) => parseInt(hex, 16))]);
  }
  entries.sort((a, b) => a[0] - b[0]);
  return entries;
}

/** Each entry as `d:t` in base 36: its distance from the entry before, then its prototype. */
function encoded(entries) {
  let previous = 0;
  return entries.map(([from, to]) => {
    const step = from - previous;
    previous = from;
    return `${step.toString(36)}:${to.map((point) => point.toString(36)).join('.')}`;
  });
}

/** `entries` joined with spaces into lines no wider than {@link LINE_WIDTH}. */
function lines(entries) {
  const out = [];
  let line = '';
  for (const entry of entries) {
    if (line !== '' && line.length + 1 + entry.length > LINE_WIDTH) {
      out.push(line);
      line = entry;
    } else {
      line = line === '' ? entry : `${line} ${entry}`;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

const bytes = await source(process.argv[2]);
const hash = createHash('sha256').update(bytes).digest();
if (!hash.equals(SOURCE_SHA256)) {
  throw new Error(`confusables.txt has SHA-256 ${hash.toString('hex')}, not the pinned one.`);
}
const entries = mappings(bytes.toString('utf8'));
const table = lines(encoded(entries));
const file = `/**
 * Unicode's confusables mapping (UTS #39), version ${VERSION}, for
 * \`skeleton.ts\` (#487; docs/spec/listed-doors.md §4.4). Generated data: don't
 * edit it by hand. \`client/scripts/confusables.mjs\` writes it from
 * ${URL_OF_FILE}
 * (SHA-256 ${SOURCE_SHA256.toString('hex')}).
 *
 * It holds all ${String(entries.length)} mappings in that file, sorted by source code point, as
 * entries separated by spaces. An entry is \`d:t\` in base 36: \`d\`, how far
 * its source is past the entry before it (the first, past 0), and \`t\`, its
 * prototype's code points joined by \`.\`.
 */

/** The Unicode version of the confusables file this table comes from. */
export const CONFUSABLES_VERSION = '${VERSION}';

/** The table, a line of entries per string. */
export const CONFUSABLES: readonly string[] = [
${table.map((line) => `  '${line}',`).join('\n')}
];
`;
await writeFile(OUT, file);
console.log(`Wrote ${String(entries.length)} mappings from Unicode ${VERSION} to src/shelf/confusables.ts.`);
