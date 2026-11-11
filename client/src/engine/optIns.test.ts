import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { LEVELS } from './capabilities';
import {
  effectiveOptIn,
  effectiveOptIns,
  isOff,
  isOptIn,
  isOptInValue,
  isWebhook,
  isWider,
  mayProposeRules,
  OFF,
  OPT_INS,
  openRulesProposal,
  rulesChange,
  sameValue,
  VALIDATORS,
  webhookParts,
  withChange,
} from './optIns';

/** The level that votes but doesn't propose, by place, so no level id is spelled out here. */
const [, VOTING] = LEVELS;

const W1 = 'https://discord.com/api/webhooks/1/abc';
const W2 = 'https://discordapp.com/api/webhooks/1234567890123456789/Ab_c-9xYz';

/** The chat bot posting through `webhook`. */
const bot = (webhook: string) => ({ webhook });

describe('the opt-ins and their off values (ADR-0038, ADR-0039, ADR-0040)', () => {
  it('names two opt-ins, the chat bot and the front door, both off', () => {
    expect(OPT_INS).toEqual(['chatBot', 'frontDoor']);
    expect(OFF).toEqual({ chatBot: null, frontDoor: false });
  });

  it('knows only those two names', () => {
    expect(isOptIn('chatBot')).toBe(true);
    expect(isOptIn('frontDoor')).toBe(true);
    for (const other of ['signalBot', 'ChatBot', '', 'bars', 'toString', null, 1]) {
      expect(isOptIn(other)).toBe(false);
    }
  });

  it('gives each opt-in its own validator', () => {
    expect(Object.keys(VALIDATORS)).toEqual([...OPT_INS]);
  });
});

describe('isWebhook: a Discord webhook URL, in the one form the bot will post to', () => {
  it.each([W1, W2, 'https://discord.com/api/webhooks/987654321/token-with-dashes_and_underscores'])(
    'accepts %s',
    (url) => {
      expect(isWebhook(url)).toBe(true);
    },
  );

  it.each([
    ['http:', 'http://discord.com/api/webhooks/1/abc'],
    ['another host', 'https://example.com/api/webhooks/1/abc'],
    ['a look-alike host', 'https://discord.com.example.com/api/webhooks/1/abc'],
    ['a subdomain', 'https://ptb.discord.com/api/webhooks/1/abc'],
    ['a capital in the host', 'https://Discord.com/api/webhooks/1/abc'],
    ['a port', 'https://discord.com:443/api/webhooks/1/abc'],
    ['a user name', 'https://me@discord.com/api/webhooks/1/abc'],
    ['a query', 'https://discord.com/api/webhooks/1/abc?wait=true'],
    ['a fragment', 'https://discord.com/api/webhooks/1/abc#x'],
    ['a trailing slash', 'https://discord.com/api/webhooks/1/abc/'],
    ['an extra segment', 'https://discord.com/api/webhooks/1/abc/slack'],
    ['an id that is not digits', 'https://discord.com/api/webhooks/one/abc'],
    ['no token', 'https://discord.com/api/webhooks/1/'],
    ['an encoded slash in the token', 'https://discord.com/api/webhooks/1/a%2Fb'],
    ['another API path', 'https://discord.com/api/channels/1/abc'],
    ['spaces around it', ` ${W1} `],
    ['a line break after it', `${W1}\n`],
    ['an empty string', ''],
  ])('refuses %s', (_name, url) => {
    expect(isWebhook(url)).toBe(false);
    expect(webhookParts(url)).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 1, {}, [W1], { webhook: W1 }]) {
      expect(isWebhook(value)).toBe(false);
      expect(webhookParts(value)).toBeNull();
    }
  });

  it('reads the id and token of a webhook it accepts, on either host (#119)', () => {
    expect(webhookParts(W1)).toEqual({ id: '1', token: 'abc' });
    expect(webhookParts(W2)).toEqual({ id: '1234567890123456789', token: 'Ab_c-9xYz' });
  });

  it('accepts only URLs a URL parser reads as https: on Discord with the webhook path', () => {
    const host = fc.constantFrom('discord.com', 'discordapp.com');
    const id = fc.stringMatching(/^\d{1,20}$/);
    const token = fc.stringMatching(/^[\w-]{1,80}$/);
    fc.assert(
      fc.property(host, id, token, (name, digits, secret) => {
        const text = `https://${name}/api/webhooks/${digits}/${secret}`;
        expect(isWebhook(text)).toBe(true);
        const url = new URL(text);
        expect(url.href).toBe(text);
        expect(url.protocol).toBe('https:');
        expect(['discord.com', 'discordapp.com']).toContain(url.hostname);
        expect(url.pathname).toMatch(/^\/api\/webhooks\/\d+\/[\w-]+$/);
      }),
    );
  });
});

describe('isOptInValue: each opt-in’s validator', () => {
  it('takes the chat bot off (null) or on with a webhook, and nothing else', () => {
    expect(isOptInValue('chatBot', null)).toBe(true);
    expect(isOptInValue('chatBot', bot(W1))).toBe(true);
    for (const value of [
      false,
      W1,
      {},
      { webhook: 'https://example.com/api/webhooks/1/abc' },
      { webhook: W1, channel: 'general' },
      [bot(W1)],
      undefined,
    ]) {
      expect(isOptInValue('chatBot', value)).toBe(false);
    }
  });

  it('refuses a chat bot whose only extra field is __proto__, as JSON.parse writes it', () => {
    const parsed: unknown = JSON.parse(`{"webhook":"${W1}","__proto__":{}}`);
    expect(isOptInValue('chatBot', parsed)).toBe(false);
  });

  it('takes the front door open (true) or closed (false), and nothing else', () => {
    expect(isOptInValue('frontDoor', true)).toBe(true);
    expect(isOptInValue('frontDoor', false)).toBe(true);
    for (const value of [null, 'true', 1, 0, {}, { open: true }]) {
      expect(isOptInValue('frontDoor', value)).toBe(false);
    }
  });
});

describe('isWider: only off to on widens (ADR-0040, ADR-0075 §5)', () => {
  it('reads the issue’s examples', () => {
    expect(isWider('chatBot', null, bot(W1))).toBe(true);
    expect(isWider('chatBot', bot(W1), null)).toBe(false);
    expect(isWider('frontDoor', false, true)).toBe(true);
  });

  it('keeps replacing one webhook with another ordinary', () => {
    expect(isWider('chatBot', bot(W1), bot(W2))).toBe(false);
  });

  it('never widens by closing, or by staying where it is', () => {
    expect(isWider('frontDoor', true, false)).toBe(false);
    expect(isWider('frontDoor', false, false)).toBe(false);
    expect(isWider('frontDoor', true, true)).toBe(false);
    expect(isWider('chatBot', null, null)).toBe(false);
  });

  it('calls a value off only when it is the off value, so a half-typed webhook is still on', () => {
    expect(isOff('chatBot', null)).toBe(true);
    expect(isOff('chatBot', bot(W1))).toBe(false);
    expect(isOff('chatBot', bot(''))).toBe(false);
    expect(isOff('frontDoor', false)).toBe(true);
    expect(isOff('frontDoor', true)).toBe(false);
    expect(isOff('frontDoor', 0)).toBe(false);
    expect(isWider('chatBot', null, bot(''))).toBe(true);
  });

  it('compares two values of an opt-in by what they hold', () => {
    expect(sameValue('chatBot', bot(W1), bot(W1))).toBe(true);
    expect(sameValue('chatBot', bot(W1), bot(W2))).toBe(false);
    expect(sameValue('chatBot', null, bot(W1))).toBe(false);
    expect(sameValue('chatBot', null, null)).toBe(true);
    expect(sameValue('frontDoor', true, true)).toBe(true);
    expect(sameValue('frontDoor', true, false)).toBe(false);
  });
});

describe('rulesChange and withChange', () => {
  it('records the value a change sets and the one it replaces', () => {
    expect(rulesChange(OFF, 'chatBot', bot(W1))).toEqual({
      kind: 'rules',
      optIn: 'chatBot',
      value: bot(W1),
      from: null,
    });
    expect(rulesChange({ ...OFF, frontDoor: true }, 'frontDoor', false)).toEqual({
      kind: 'rules',
      optIn: 'frontDoor',
      value: false,
      from: true,
    });
  });

  it('makes no change for an unknown opt-in or a value its validator refuses', () => {
    expect(rulesChange(OFF, 'signalBot', true)).toBeNull();
    expect(rulesChange(OFF, 'chatBot', bot('http://discord.com/api/webhooks/1/abc'))).toBeNull();
    expect(rulesChange(OFF, 'frontDoor', 'open')).toBeNull();
  });

  it('sets only the opt-in the change names', () => {
    const on = rulesChange(OFF, 'chatBot', bot(W1));
    const open = rulesChange(OFF, 'frontDoor', true);
    if (on === null || open === null) throw new Error('Expected two changes.');
    expect(withChange(OFF, on)).toEqual({ chatBot: bot(W1), frontDoor: false });
    expect(withChange(OFF, open)).toEqual({ chatBot: null, frontDoor: true });
  });
});

describe('rules Proposals in a folded group', () => {
  const ANA = authorOf('ana');

  it('lets a Co-Creator propose a value that differs from the one standing, one at a time', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const state = log.state();
    expect(mayProposeRules(state, ANA, { optIn: 'chatBot', value: bot(W1) })).toBe(true);
    expect(mayProposeRules(state, ANA, { optIn: 'chatBot', value: null })).toBe(false);
    expect(mayProposeRules(state, ANA, { optIn: 'frontDoor', value: false })).toBe(false);
    log.rules('Ana', 'chatBot', bot(W1));
    const later = log.state();
    expect(openRulesProposal(later, 'chatBot')?.author).toBe(ANA);
    expect(openRulesProposal(later, 'frontDoor')).toBeUndefined();
    expect(mayProposeRules(later, ANA, { optIn: 'chatBot', value: bot(W2) })).toBe(false);
    expect(mayProposeRules(later, ANA, { optIn: 'frontDoor', value: true })).toBe(true);
  });

  it('refuses a Proposal from someone who can’t propose, or for an unknown opt-in', () => {
    const log = groupLog({ members: ['Ben'], levels: { Ben: VOTING } });
    const state = log.state();
    expect(mayProposeRules(state, authorOf('ben'), { optIn: 'frontDoor', value: true })).toBe(
      false,
    );
    expect(mayProposeRules(state, ANA, { optIn: 'signalBot', value: true })).toBe(false);
  });

  it('holds each opt-in at its standing value while no steward has narrowed it', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposal = log.rules('Ana', 'frontDoor', true);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
    const state = log.state();
    expect(state.rules.optIns.frontDoor).toBe(true);
    expect(effectiveOptIn(state, 'frontDoor')).toBe(true);
    expect(effectiveOptIns(state)).toEqual({ chatBot: null, frontDoor: true });
  });
});
