import { describe, expect, it } from 'vitest';

import { parseRecord } from '../engine/event';
import { authorOf, signedAs } from '../test/keys';
import { groupLog } from '../test/votes';
import { documentTitle, senderOf, waitingDispatches } from './dispatchLines';

describe('senderOf (#112)', () => {
  it('names a member, a former member, or a Proposal by its title', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposal = log.propose('Ana', { title: 'Share the tools' });
    log.leave('Cal');
    const state = log.state();
    expect(senderOf(state, authorOf('ana'))).toEqual({ kind: 'member', name: 'Ana' });
    expect(senderOf(state, authorOf('cal'))).toEqual({ kind: 'member', name: 'Cal' });
    expect(senderOf(state, { proposal })).toEqual({
      kind: 'proposal',
      id: proposal,
      title: 'Share the tools',
    });
  });

  it('names nobody it doesn’t know, rather than failing', () => {
    const state = groupLog().state();
    expect(senderOf(state, authorOf('zed'))).toEqual({ kind: 'member', name: '' });
    expect(senderOf(state, { proposal: 'gone' })).toEqual({
      kind: 'proposal',
      id: 'gone',
      title: '',
    });
  });
});

describe('documentTitle', () => {
  it('gives the group’s Document title for its id, and none for no Document or another id', () => {
    const log = groupLog();
    const state = log.state();
    expect(documentTitle(state, log.group)).toBe('House rules');
    expect(documentTitle(state, null)).toBeNull();
    expect(documentTitle(state, `${log.group}.0`)).toBeNull();
  });
});

describe('waitingDispatches', () => {
  it('keeps this member’s own Dispatches in the outbox, in order, and nothing else', () => {
    const log = groupLog();
    const { group } = log;
    const sign = (name: string, title: string) =>
      parseRecord(
        signedAs(name, { type: 'dispatch', group, ts: 0, body: { title, text: '', doc: group } })
          .record,
      );
    const level = parseRecord(
      signedAs('ana', { type: 'level', group, ts: 0, body: { level: 'x' } }).record,
    );
    const pending = [sign('ana', 'First'), sign('ben', 'Ben’s'), level, sign('ana', 'Second')];
    const waiting = waitingDispatches(
      log.state(),
      authorOf('ana'),
      pending.filter((event) => event !== null),
    );
    expect(waiting.map((dispatch) => [dispatch.title, dispatch.doc])).toEqual([
      ['First', group],
      ['Second', group],
    ]);
  });
});
