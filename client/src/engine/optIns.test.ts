import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { COUNTED, DOOR, doorOf, ROTATED } from '../test/door';
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

  it('takes the front door closed (false) or open with its two secrets and a count choice (#121)', () => {
    expect(isOptInValue('frontDoor', false)).toBe(true);
    expect(isOptInValue('frontDoor', DOOR)).toBe(true);
    expect(isOptInValue('frontDoor', COUNTED)).toBe(true);
    for (const value of [null, true, 'true', 1, 0, {}, { open: true }, [DOOR], undefined]) {
      expect(isOptInValue('frontDoor', value)).toBe(false);
    }
  });

  it.each([
    ['no sign', { box: DOOR.box, showCount: false }],
    ['no box', { sign: DOOR.sign, showCount: false }],
    ['no showCount', { sign: DOOR.sign, box: DOOR.box }],
    ['a showCount that is not true or false', { ...DOOR, showCount: 1 }],
    ['a sign of 31 bytes', { ...DOOR, sign: DOOR.sign.slice(0, 42) }],
    ['a box of 33 bytes', { ...DOOR, box: `${DOOR.box}A` }],
    ['a sign that is not text', { ...DOOR, sign: 7 }],
    ['a box with a character base64url lacks', { ...DOOR, box: `${DOOR.box.slice(0, 42)}+` }],
    // 'R' leaves a spare bit set in the last character, so these 32 bytes have a second spelling.
    ['a sign spelled with spare bits set', { ...DOOR, sign: `${DOOR.sign.slice(0, 42)}R` }],
    ['an extra field', { ...DOOR, open: true }],
  ])('refuses a front door with %s', (_name, value) => {
    expect(isOptInValue('frontDoor', value)).toBe(false);
  });

  it('refuses a front door whose only extra field is __proto__, as JSON.parse writes it', () => {
    const parsed: unknown = JSON.parse(
      `{"sign":"${DOOR.sign}","box":"${DOOR.box}","showCount":false,"__proto__":{}}`,
    );
    expect(isOptInValue('frontDoor', parsed)).toBe(false);
  });

  it('takes any 32 bytes as either secret, as every 32 bytes are a key of each kind', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.boolean(), (bytes, count) => {
        const value = { sign: base64urlOf(bytes), box: base64urlOf(bytes), showCount: count };
        expect(isOptInValue('frontDoor', value)).toBe(true);
      }),
    );
  });
});

/** Unpadded base64url, written out here so the property doesn't lean on the code it checks. */
function base64urlOf(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

describe('isWider: only what outsiders can see or reach widens (ADR-0040, ADR-0075 §5)', () => {
  it('reads the issue’s examples', () => {
    expect(isWider('chatBot', null, bot(W1))).toBe(true);
    expect(isWider('chatBot', bot(W1), null)).toBe(false);
    expect(isWider('frontDoor', false, DOOR)).toBe(true);
  });

  it('widens the front door from closed to open, and from hiding the count to showing it (#121)', () => {
    expect(isWider('frontDoor', false, COUNTED)).toBe(true);
    expect(isWider('frontDoor', DOOR, COUNTED)).toBe(true);
    expect(isWider('frontDoor', DOOR, { ...ROTATED, showCount: true })).toBe(true);
  });

  it('keeps rotating the door’s keys, and turning its count off, ordinary (#121)', () => {
    expect(isWider('frontDoor', DOOR, ROTATED)).toBe(false);
    expect(isWider('frontDoor', COUNTED, { ...ROTATED, showCount: true })).toBe(false);
    expect(isWider('frontDoor', COUNTED, DOOR)).toBe(false);
    expect(isWider('frontDoor', COUNTED, ROTATED)).toBe(false);
    expect(isWider('frontDoor', COUNTED, false)).toBe(false);
  });

  it('reads a front door no validator accepts as showing everything, so it can only ever widen', () => {
    expect(isWider('frontDoor', false, true)).toBe(true);
    expect(isWider('frontDoor', DOOR, { ...DOOR, showCount: 'no' })).toBe(true);
    expect(isWider('frontDoor', DOOR, {})).toBe(true);
  });

  it('keeps replacing one webhook with another ordinary', () => {
    expect(isWider('chatBot', bot(W1), bot(W2))).toBe(false);
  });

  it('never widens by closing, or by staying where it is', () => {
    expect(isWider('frontDoor', DOOR, false)).toBe(false);
    expect(isWider('frontDoor', false, false)).toBe(false);
    expect(isWider('frontDoor', DOOR, DOOR)).toBe(false);
    expect(isWider('frontDoor', COUNTED, COUNTED)).toBe(false);
    expect(isWider('chatBot', null, null)).toBe(false);
  });

  it('widens exactly when the open-and-count pair grows, whatever the keys (fast-check)', () => {
    const door = fc.oneof(
      fc.constant<false>(false),
      fc
        .record({ sign: fc.integer({ min: 0, max: 255 }), box: fc.integer({ min: 0, max: 255 }) })
        .chain(({ sign, box }) => fc.boolean().map((count) => doorOf(sign, box, count))),
    );
    const rank = (value: false | { readonly showCount: boolean }) =>
      value === false ? 0 : value.showCount ? 2 : 1;
    fc.assert(
      fc.property(door, door, (from, to) => {
        expect(isWider('frontDoor', from, to)).toBe(rank(to) > rank(from));
      }),
    );
  });

  it('calls a value off only when it is the off value, so a half-typed webhook is still on', () => {
    expect(isOff('chatBot', null)).toBe(true);
    expect(isOff('chatBot', bot(W1))).toBe(false);
    expect(isOff('chatBot', bot(''))).toBe(false);
    expect(isOff('frontDoor', false)).toBe(true);
    expect(isOff('frontDoor', DOOR)).toBe(false);
    expect(isOff('frontDoor', true)).toBe(false);
    expect(isOff('frontDoor', 0)).toBe(false);
    expect(isWider('chatBot', null, bot(''))).toBe(true);
  });

  it('compares two values of an opt-in by what they hold', () => {
    expect(sameValue('chatBot', bot(W1), bot(W1))).toBe(true);
    expect(sameValue('chatBot', bot(W1), bot(W2))).toBe(false);
    expect(sameValue('chatBot', null, bot(W1))).toBe(false);
    expect(sameValue('chatBot', null, null)).toBe(true);
    expect(sameValue('frontDoor', DOOR, { ...DOOR })).toBe(true);
    expect(sameValue('frontDoor', false, false)).toBe(true);
    expect(sameValue('frontDoor', DOOR, false)).toBe(false);
    expect(sameValue('frontDoor', false, DOOR)).toBe(false);
    expect(sameValue('frontDoor', DOOR, COUNTED)).toBe(false);
    expect(sameValue('frontDoor', DOOR, ROTATED)).toBe(false);
    expect(sameValue('frontDoor', DOOR, { ...DOOR, sign: ROTATED.sign })).toBe(false);
    expect(sameValue('frontDoor', DOOR, { ...DOOR, box: ROTATED.box })).toBe(false);
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
    expect(rulesChange({ ...OFF, frontDoor: DOOR }, 'frontDoor', false)).toEqual({
      kind: 'rules',
      optIn: 'frontDoor',
      value: false,
      from: DOOR,
    });
  });

  it('makes no change for an unknown opt-in or a value its validator refuses', () => {
    expect(rulesChange(OFF, 'signalBot', true)).toBeNull();
    expect(rulesChange(OFF, 'chatBot', bot('http://discord.com/api/webhooks/1/abc'))).toBeNull();
    expect(rulesChange(OFF, 'frontDoor', 'open')).toBeNull();
    expect(rulesChange(OFF, 'frontDoor', true)).toBeNull();
  });

  it('sets only the opt-in the change names', () => {
    const on = rulesChange(OFF, 'chatBot', bot(W1));
    const open = rulesChange(OFF, 'frontDoor', DOOR);
    if (on === null || open === null) throw new Error('Expected two changes.');
    expect(withChange(OFF, on)).toEqual({ chatBot: bot(W1), frontDoor: false });
    expect(withChange(OFF, open)).toEqual({ chatBot: null, frontDoor: DOOR });
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
    expect(mayProposeRules(later, ANA, { optIn: 'frontDoor', value: DOOR })).toBe(true);
  });

  it('refuses a Proposal from someone who can’t propose, or for an unknown opt-in', () => {
    const log = groupLog({ members: ['Ben'], levels: { Ben: VOTING } });
    const state = log.state();
    expect(mayProposeRules(state, authorOf('ben'), { optIn: 'frontDoor', value: DOOR })).toBe(
      false,
    );
    expect(mayProposeRules(state, ANA, { optIn: 'signalBot', value: true })).toBe(false);
  });

  it('holds each opt-in at its standing value while no steward has narrowed it', () => {
    const log = groupLog({ members: ['Ben', 'Cal'] });
    const proposal = log.rules('Ana', 'frontDoor', DOOR);
    for (const name of ['Ana', 'Ben', 'Cal']) log.vote(name, proposal, 4);
    const state = log.state();
    expect(state.rules.optIns.frontDoor).toEqual(DOOR);
    expect(effectiveOptIn(state, 'frontDoor')).toEqual(DOOR);
    expect(effectiveOptIns(state)).toEqual({ chatBot: null, frontDoor: DOOR });
  });
});
