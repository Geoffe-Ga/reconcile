import { describe, expect, it } from 'vitest';

import { OFF, rulesChange } from '../engine/optIns';
import { COUNTED, COVENANT_HASH, DOOR, LISTED, RENEWED, ROTATED } from '../test/door';
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
      covenant: null,
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
      covenant: null,
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

describe('rulesView of a listing (#485; listed-doors.md §3.1)', () => {
  const open = { ...OFF, frontDoor: DOOR };
  const listed = { ...OFF, frontDoor: LISTED };

  it('heads listing an open door with its own motion, and names the covenant it accepts', () => {
    expect(rulesView(change('frontDoor', LISTED, open))).toEqual<RulesView>({
      optIn: 'frontDoor',
      title: 'List the front door on the public shelf',
      line: 'If this passes, the front door changes. Your group’s name goes on the public shelf, under the covenant below.',
      passed: 'This passed. Your group’s front door is listed on the public shelf.',
      tail: null,
      covenant: COVENANT_HASH,
    });
  });

  it('words opening and listing at once as opening, with the listing after it', () => {
    const view = rulesView(change('frontDoor', LISTED));
    expect(view).toMatchObject({
      title: 'Open a front door',
      line: 'If this passes, your group gets a public page where people can ask to join. Your group’s name goes on the public shelf, under the covenant below.',
      passed: 'This passed. Your group’s front door is open and listed on the public shelf.',
      covenant: COVENANT_HASH,
    });
  });

  it('words unlisting, and closing a listed door, with no covenant to show', () => {
    expect(rulesView(change('frontDoor', DOOR, listed))).toEqual<RulesView>({
      optIn: 'frontDoor',
      title: 'Take the front door off the public shelf',
      line: 'If this passes, the front door changes. Your group comes off the public shelf.',
      passed: 'This passed. Your group’s front door is off the public shelf.',
      tail: null,
      covenant: null,
    });
    expect(rulesView(change('frontDoor', false, listed)).line).toBe(
      'If this passes, the front door closes. Your group comes off the public shelf.',
    );
  });

  it('words accepting another covenant version, and names it', () => {
    expect(rulesView(change('frontDoor', RENEWED, listed))).toMatchObject({
      title: 'Accept the new covenant',
      line: 'If this passes, the front door changes. Your group’s listing accepts the covenant below in place of the one it accepted before.',
      passed: 'This passed. Your group’s listing accepts the new covenant.',
      covenant: RENEWED.covenant,
    });
  });

  it('shows no covenant when a listed door changes in another way only', () => {
    const view = rulesView(change('frontDoor', { ...LISTED, showCount: true }, listed));
    expect(view.covenant).toBeNull();
    expect(view.title).toBe('Change the front door');
  });

  it('keeps the general heading when the door’s link or count changes beside its listing', () => {
    const view = rulesView(
      change('frontDoor', { ...ROTATED, listed: true, covenant: COVENANT_HASH }, open),
    );
    expect(view.title).toBe('Change the front door');
    expect(view.line).toBe(
      'If this passes, the front door changes. It moves to a new link, and the old link closes. Your group’s name goes on the public shelf, under the covenant below.',
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
