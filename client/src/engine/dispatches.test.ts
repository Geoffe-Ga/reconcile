import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { LEVELS } from './capabilities';
import {
  DISPATCH_TEXT_MAX,
  DISPATCH_TITLE_MAX,
  dispatchFits,
  documentIds,
  latestDispatch,
  maySendDispatch,
  newestFirst,
} from './dispatches';

const [MEMBER, VOTING] = LEVELS;

describe('dispatchFits (#112)', () => {
  it('takes a title of 1 to 80 code points and a text of up to 500', () => {
    expect(DISPATCH_TITLE_MAX).toBe(80);
    expect(DISPATCH_TEXT_MAX).toBe(500);
    expect(dispatchFits({ title: 'a', text: '' })).toBe(true);
    expect(dispatchFits({ title: 'a'.repeat(80), text: 'b'.repeat(500) })).toBe(true);
    expect(dispatchFits({ title: '', text: '' })).toBe(false);
    expect(dispatchFits({ title: 'a'.repeat(81), text: '' })).toBe(false);
    expect(dispatchFits({ title: 'a', text: 'b'.repeat(501) })).toBe(false);
  });

  it('counts code points, so an astral character counts once', () => {
    expect(dispatchFits({ title: '\u{1F600}'.repeat(80), text: '' })).toBe(true);
    expect(dispatchFits({ title: 'a', text: '\u{1F600}'.repeat(500) })).toBe(true);
    expect(dispatchFits({ title: 'a', text: '\u{1F600}'.repeat(501) })).toBe(false);
  });
});

describe('documentIds', () => {
  it('lists each Document once, in the order its first Atom comes', () => {
    const atoms = [{ documentId: 'g' }, { documentId: 'g' }, { documentId: 'h' }];
    expect(documentIds({ atoms })).toEqual(['g', 'h']);
    expect(documentIds({ atoms: [] })).toEqual([]);
  });
});

describe('maySendDispatch', () => {
  const log = groupLog({ members: ['Ben', 'Kim'], levels: { Ben: VOTING, Kim: MEMBER } });
  const state = log.state();
  const body = { title: 'Meet on Sunday', text: '' };

  it('lets a Co-Creator send one, and neither a Collaborator nor a Member', () => {
    expect(maySendDispatch(state, authorOf('ana'), body)).toBe(true);
    expect(maySendDispatch(state, authorOf('ben'), body)).toBe(false);
    expect(maySendDispatch(state, authorOf('kim'), body)).toBe(false);
    expect(maySendDispatch(state, authorOf('zed'), body)).toBe(false);
  });

  it('takes a doc only when it names one of the group’s Documents', () => {
    const ana = authorOf('ana');
    expect(maySendDispatch(state, ana, { ...body, doc: log.group })).toBe(true);
    expect(maySendDispatch(state, ana, { ...body, doc: `${log.group}.0` })).toBe(false);
    expect(maySendDispatch(state, ana, { ...body, doc: '' })).toBe(false);
  });

  it('refuses words that don’t fit', () => {
    expect(maySendDispatch(state, authorOf('ana'), { title: '', text: '' })).toBe(false);
  });
});

describe('newestFirst and latestDispatch', () => {
  it('list the group’s Dispatches newest first, and name the latest, or none', () => {
    const log = groupLog();
    expect(newestFirst(log.state())).toEqual([]);
    expect(latestDispatch(log.state())).toBeNull();
    const first = log.dispatch('Ana', { title: 'First', text: '' });
    log.minute += 1;
    const second = log.dispatch('Ana', { title: 'Second', text: '' });
    const state = log.state();
    expect(newestFirst(state).map((d) => d.id)).toEqual([second, first]);
    expect(latestDispatch(state)?.id).toBe(second);
    // The fold's own list keeps its order.
    expect(state.dispatches.map((d) => d.id)).toEqual([first, second]);
  });
});
