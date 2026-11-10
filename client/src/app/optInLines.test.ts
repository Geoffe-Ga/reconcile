import { describe, expect, it } from 'vitest';

import { OFF, rulesChange } from '../engine/optIns';
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
    expect(directionOf(change('frontDoor', true))).toBe('on');
    expect(directionOf(change('frontDoor', false, { ...OFF, frontDoor: true }))).toBe('off');
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
    expect(rulesView(change('frontDoor', true))).toMatchObject({
      title: 'Open a front door',
      passed: 'This passed. Your group’s front door is open.',
      tail: null,
    });
    expect(rulesView(change('frontDoor', false, { ...OFF, frontDoor: true }))).toMatchObject({
      title: 'Close the front door',
      line: 'If this passes, the front door closes.',
    });
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
