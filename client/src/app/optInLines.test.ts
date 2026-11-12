import { describe, expect, it } from 'vitest';

import { OFF, rulesChange } from '../engine/optIns';
import { COUNTED, DOOR, ROTATED } from '../test/door';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { directionOf, optInState, type RulesView, rulesView, webhookTail } from './optInLines';

const W1 = 'https://discord.com/api/webhooks/1/abcdWXYZ';
const W2 = 'https://discord.com/api/webhooks/2/efgh1234';
const bot = (webhook: string) => ({ webhook });

/** The change setting `optIn` to `value` from the standing `from`. */
function change(optIn: string, value: unknown, from = OFF) {
  const made = rulesChange(from, optIn, value);
  if (made === null) throw new Error('Expected a change.');
  return made;
}

describe('webhookTail', () => {
  it('keeps only the last 4 characters, which is all a screen shows of a webhook', () => {
    expect(webhookTail(W1)).toBe('WXYZ');
    expect(webhookTail('abc')).toBe('abc');
  });
});

describe('directionOf', () => {
  it('reads turning on, turning off, and replacing one webhook with another', () => {
    expect(directionOf(change('chatBot', bot(W1)))).toBe('on');
    expect(directionOf(change('chatBot', null, { ...OFF, chatBot: bot(W1) }))).toBe('off');
    expect(directionOf(change('chatBot', bot(W2), { ...OFF, chatBot: bot(W1) }))).toBe('replace');
    expect(directionOf(change('frontDoor', DOOR))).toBe('on');
    expect(directionOf(change('frontDoor', false, { ...OFF, frontDoor: DOOR }))).toBe('off');
    expect(directionOf(change('frontDoor', ROTATED, { ...OFF, frontDoor: DOOR }))).toBe('replace');
  });
});

describe('rulesView: what a rules ballot decides, in words', () => {
  it('heads turning the bot on with its motion, its line, its pass and its webhook’s last 4', () => {
    expect(rulesView(change('chatBot', bot(W1)))).toEqual<RulesView>({
      optIn: 'chatBot',
      title: 'Turn on the Discord chat bot',
      line: 'If this passes, the bot posts content-free nudges in the channel the webhook belongs to.',
      passed: 'This passed. The Discord chat bot is on.',
      tail: 'WXYZ',
    });
  });

  it('shows a replaced webhook by its new last 4, and turning off with none', () => {
    const replaced = rulesView(change('chatBot', bot(W2), { ...OFF, chatBot: bot(W1) }));
    expect(replaced.title).toBe('Replace the chat bot’s webhook');
    expect(replaced.tail).toBe('1234');
    const off = rulesView(change('chatBot', null, { ...OFF, chatBot: bot(W1) }));
    expect(off.title).toBe('Turn off the Discord chat bot');
    expect(off.passed).toBe('This passed. The Discord chat bot is off.');
    expect(off.tail).toBeNull();
  });

  it('words the front door opening and closing', () => {
    expect(rulesView(change('frontDoor', DOOR))).toMatchObject({
      title: 'Open a front door',
      passed: 'This passed. Your group’s front door is open.',
      tail: null,
    });
    expect(rulesView(change('frontDoor', false, { ...OFF, frontDoor: DOOR }))).toMatchObject({
      title: 'Close the front door',
      line: 'If this passes, the front door closes.',
    });
  });

  it('says when an opening shows the count, and leaves it unsaid when it doesn’t (#121)', () => {
    expect(rulesView(change('frontDoor', DOOR)).line).toBe(
      'If this passes, your group gets a public page where people can ask to join.',
    );
    expect(rulesView(change('frontDoor', COUNTED)).line).toBe(
      'If this passes, your group gets a public page where people can ask to join. Its page shows how many people are in your group.',
    );
  });

  it('words a change of an open door by what changes: its link, its count, or both (#121)', () => {
    const open = { ...OFF, frontDoor: DOOR };
    expect(rulesView(change('frontDoor', ROTATED, open))).toEqual<RulesView>({
      optIn: 'frontDoor',
      title: 'Change the front door',
      line: 'If this passes, the front door changes. It moves to a new link, and the old link closes.',
      passed: 'This passed. The front door changed.',
      tail: null,
    });
    expect(rulesView(change('frontDoor', COUNTED, open)).line).toBe(
      'If this passes, the front door changes. Its page shows how many people are in your group.',
    );
    expect(rulesView(change('frontDoor', DOOR, { ...OFF, frontDoor: COUNTED })).line).toBe(
      'If this passes, the front door changes. Its page stops showing how many people are in your group.',
    );
    expect(rulesView(change('frontDoor', { ...ROTATED, showCount: true }, open)).line).toBe(
      'If this passes, the front door changes. It moves to a new link, and the old link closes. Its page shows how many people are in your group.',
    );
  });
});

describe('rulesView of a front door Proposal open when a member left (#288)', () => {
  it('says passing it opens no door, and its pass that the door stays closed', () => {
    const view = rulesView(change('frontDoor', DOOR), true);
    expect(view.line).toBe(
      'If this passes, your group gets a public page where people can ask to join. A member left while this vote was open, and they have the keys it carries, so if it passes the front door stays closed. A new Proposal to open it reopens it.',
    );
    expect(view.passed).toBe(
      'This passed, but the front door stays closed: a member left while the vote was open, and they have its keys. A new Proposal to open it reopens it.',
    );
    expect(view.title).toBe('Open a front door');
  });

  it('words a Proposal no one left during as before', () => {
    expect(rulesView(change('frontDoor', DOOR), false)).toEqual(
      rulesView(change('frontDoor', DOOR)),
    );
  });
});

describe('optInState: where an opt-in stands now', () => {
  it('reads each opt-in off at founding', () => {
    const state = groupLog({ members: ['Ben', 'Cal'] }).state();
    expect(optInState(state, 'chatBot')).toEqual({ kind: 'off', label: 'Off' });
    expect(optInState(state, 'frontDoor')).toEqual({ kind: 'off', label: 'Closed' });
  });

  it('reads the bot on with its webhook’s last 4, and names the steward who narrowed it', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const on = log.rules('Ana', 'chatBot', bot(W1));
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, on, 4);
    expect(optInState(log.state(), 'chatBot')).toEqual({ kind: 'on', label: 'On', tail: 'WXYZ' });
    const off = log.rules('Ana', 'chatBot', null);
    log.narrow('Ana', 'chatBot', off);
    expect(optInState(log.state(), 'chatBot')).toEqual({
      kind: 'narrowed',
      label: 'Off',
      by: authorOf('ana'),
      proposal: off,
    });
  });
});
