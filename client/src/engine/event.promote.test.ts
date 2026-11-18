/**
 * Parsing the two Proposals that let a Dispatch rise (#126; ADR-0037,
 * ADR-0071): a group's Dispatch put to a vote with a ceiling, and the
 * promotion record a coalition takes up.
 */
import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import {
  base64url,
  CEILINGS,
  isDispatchProposal,
  isPromoteProposal,
  isRulesProposal,
  parseEvent,
  type Reach,
} from './event';

const ANA = authorOf('ana');
const SEAT = base64url(new Uint8Array(32).fill(5));

/** UTF-8 bytes of a JSON value, serialized once. */
function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** A valid v1 `proposal` envelope around `body`. */
function proposal(body: unknown): Uint8Array {
  return json({ v: 1, type: 'proposal', group: 'g1', author: ANA, ts: 1, body });
}

/** The parsed body of a `proposal` envelope, or null when it doesn't parse. */
function bodyOf(body: unknown) {
  const parsed = parseEvent(proposal(body));
  return parsed?.event.type === 'proposal' ? parsed.event.body : null;
}

const WORDS = { title: 'Rally Saturday', text: 'Meet at the river at ten.' };

const DISPATCH = {
  target: { kind: 'dispatch', ceiling: 1 },
  title: 'Rally Saturday',
  why: 'The coalitions should hear.',
  dispatch: WORDS,
};

const PROMOTE = {
  target: {
    kind: 'promote',
    dispatch: { id: 'd1', ...WORDS },
    ceiling: 'coalitions',
    level: 1,
    from: SEAT,
  },
  title: 'Rally Saturday',
  why: '',
};

describe('a Dispatch put to a vote (#126)', () => {
  it('names its ceilings lowest first, with no 0: this group only is a plain dispatch', () => {
    expect(CEILINGS).toEqual([1, 2, 'coalitions']);
  });

  it.each(CEILINGS.map((ceiling) => [ceiling]))('reads a ceiling of %s', (ceiling) => {
    const body = bodyOf({ ...DISPATCH, target: { kind: 'dispatch', ceiling } });
    expect(body).toEqual({ ...DISPATCH, target: { kind: 'dispatch', ceiling } });
    expect(body !== null && isDispatchProposal(body)).toBe(true);
    expect(body !== null && isPromoteProposal(body)).toBe(false);
  });

  it('keeps its Document, link and window, and drops text, unknown keys and a Dispatch’s doc', () => {
    const body = bodyOf({
      ...DISPATCH,
      target: { kind: 'dispatch', ceiling: 2, doc: 'g1', extra: 1 },
      link: 'https://example.org/t',
      window: 5,
      text: 'dropped',
      dispatch: { ...WORDS, doc: 'g1' },
    });
    expect(body).toEqual({
      ...DISPATCH,
      target: { kind: 'dispatch', ceiling: 2, doc: 'g1' },
      link: 'https://example.org/t',
      window: 5,
    });
  });

  it.each([
    ['a ceiling of 0', { ...DISPATCH, target: { kind: 'dispatch', ceiling: 0 } }],
    ['a ceiling of 3', { ...DISPATCH, target: { kind: 'dispatch', ceiling: 3 } }],
    ['a ceiling of "everyone"', { ...DISPATCH, target: { kind: 'dispatch', ceiling: 'everyone' } }],
    ['a ceiling as text', { ...DISPATCH, target: { kind: 'dispatch', ceiling: '1' } }],
    ['no ceiling', { ...DISPATCH, target: { kind: 'dispatch' } }],
    [
      'a Document that isn’t text',
      { ...DISPATCH, target: { kind: 'dispatch', ceiling: 1, doc: 7 } },
    ],
    ['no Dispatch', { ...DISPATCH, dispatch: undefined }],
    ['a Dispatch without text', { ...DISPATCH, dispatch: { title: 'T' } }],
    ['a window that isn’t a number', { ...DISPATCH, window: '5' }],
    ['an Atom', { ...DISPATCH, atom: 'g1.0' }],
  ])('refuses one with %s', (_label, body) => {
    expect(parseEvent(proposal(body))).toBeNull();
  });
});

describe('a shelf line on a Dispatch put to a vote (#430)', () => {
  const reaches: readonly (readonly [Reach])[] = [[0], ...CEILINGS.map((c) => [c] as const)];
  it.each(reaches)('reads shelf: true with a reach of %s, 0 only beside it', (ceiling) => {
    const target = { kind: 'dispatch', ceiling, doc: 'g1', shelf: true };
    expect(bodyOf({ ...DISPATCH, target })).toEqual({ ...DISPATCH, target });
  });

  it.each([
    ['shelf: false', { kind: 'dispatch', ceiling: 1, shelf: false }],
    ['shelf as text', { kind: 'dispatch', ceiling: 1, shelf: 'true' }],
    ['shelf as 1', { kind: 'dispatch', ceiling: 0, shelf: 1 }],
    ['a reach of 0 and shelf: false', { kind: 'dispatch', ceiling: 0, shelf: false }],
    ['a reach of "0" beside the shelf', { kind: 'dispatch', ceiling: '0', shelf: true }],
  ])('refuses one with %s', (_label, target) => {
    expect(parseEvent(proposal({ ...DISPATCH, target }))).toBeNull();
  });

  it('drops a shelf line from a promotion record: a coalition has no door', () => {
    const body = bodyOf({ ...PROMOTE, target: { ...PROMOTE.target, shelf: true } });
    expect(body).toEqual(PROMOTE);
  });
});

describe('a promotion record (#126)', () => {
  it('reads its Dispatch, ceiling, level and seat, dropping unknown keys', () => {
    const body = bodyOf({
      ...PROMOTE,
      target: { ...PROMOTE.target, extra: 1, dispatch: { ...PROMOTE.target.dispatch, doc: 'x' } },
    });
    expect(body).toEqual(PROMOTE);
    expect(body !== null && isPromoteProposal(body)).toBe(true);
    expect(body !== null && isDispatchProposal(body)).toBe(false);
    expect(body !== null && isRulesProposal(body)).toBe(false);
  });

  it.each([1, 2, 3, 4])('reads level %s, which the fold bounds', (level) => {
    expect(bodyOf({ ...PROMOTE, target: { ...PROMOTE.target, level } })).not.toBeNull();
  });

  /** PROMOTE with `change` merged into its target. */
  const withTarget = (change: object) => ({ ...PROMOTE, target: { ...PROMOTE.target, ...change } });

  it.each([
    ['level 0', withTarget({ level: 0 })],
    ['a level that isn’t whole', withTarget({ level: 1.5 })],
    ['no level', withTarget({ level: undefined })],
    ['a ceiling of 0', withTarget({ ceiling: 0 })],
    ['a ceiling of "everyone"', withTarget({ ceiling: 'everyone' })],
    ['a seat key that isn’t one', withTarget({ from: 'abc' })],
    ['a seat key that isn’t canonical', withTarget({ from: `${SEAT.slice(0, 42)}B` })],
    ['no Dispatch', withTarget({ dispatch: undefined })],
    ['a Dispatch without an id', withTarget({ dispatch: WORDS })],
    ['a Dispatch without text', withTarget({ dispatch: { id: 'd1', title: 'T' } })],
    ['a Dispatch of its own', { ...PROMOTE, dispatch: WORDS }],
    ['a link', { ...PROMOTE, link: 'https://example.org/t' }],
    ['a window', { ...PROMOTE, window: 7 }],
    ['an Atom', { ...PROMOTE, atom: 'g1.0' }],
    ['no title', { ...PROMOTE, title: undefined }],
    ['no why', { ...PROMOTE, why: undefined }],
  ])('refuses one with %s', (_label, body) => {
    expect(parseEvent(proposal(body))).toBeNull();
  });
});
