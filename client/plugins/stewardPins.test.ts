/**
 * The steward's pins as a build setting (#505): `vite.config.ts` defines the
 * app's pins from these two settings, so a malformed one fails the build.
 */
import { describe, expect, it } from 'vitest';

import {
  PIN_BOX_SETTING,
  PIN_SIGN_SETTING,
  PINS_GLOBAL,
  stewardPinsDefine,
  stewardPinsFrom,
} from './stewardPins.ts';

/** A 32-byte key in canonical unpadded base64url, every byte `fill`. */
const key = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');

const SIGN = key(0x51);
const BOX = key(0x52);
const BOTH = { [PIN_SIGN_SETTING]: SIGN, [PIN_BOX_SETTING]: BOX };

describe('stewardPinsFrom', () => {
  it('names the two settings', () => {
    expect([PIN_SIGN_SETTING, PIN_BOX_SETTING]).toEqual([
      'RECONCILE_STEWARD_PIN_SIGN',
      'RECONCILE_STEWARD_PIN_BOX',
    ]);
  });

  it('is null with neither setting, or with both empty', () => {
    expect(stewardPinsFrom({})).toBeNull();
    expect(stewardPinsFrom({ [PIN_SIGN_SETTING]: '', [PIN_BOX_SETTING]: '' })).toBeNull();
    expect(stewardPinsFrom({ OTHER: SIGN })).toBeNull();
  });

  it('pins the two keys the settings hold', () => {
    expect(stewardPinsFrom(BOTH)).toEqual({ sign: SIGN, box: BOX });
  });

  it('refuses one setting without the other', () => {
    const both =
      /^Set both RECONCILE_STEWARD_PIN_SIGN and RECONCILE_STEWARD_PIN_BOX, or neither\.$/;
    expect(() => stewardPinsFrom({ [PIN_SIGN_SETTING]: SIGN })).toThrow(both);
    expect(() => stewardPinsFrom({ [PIN_BOX_SETTING]: BOX, [PIN_SIGN_SETTING]: '' })).toThrow(both);
  });

  it.each([
    ['padded', `${SIGN}=`],
    ['standard base64', Buffer.alloc(32, 0xfb).toString('base64').replace(/=+$/, '')],
    ['short', SIGN.slice(0, 42)],
    ['long', `${SIGN}A`],
    ['spaced', ` ${SIGN}`],
    ['spare bits set', `${SIGN.slice(0, 42)}R`],
    ['64 bytes', Buffer.alloc(64, 7).toString('base64url')],
  ])('refuses a pin that is %s, in either setting', (_, bad) => {
    expect(() => stewardPinsFrom({ ...BOTH, [PIN_SIGN_SETTING]: bad })).toThrow(
      /^RECONCILE_STEWARD_PIN_SIGN must be one of the steward’s public keys/,
    );
    expect(() => stewardPinsFrom({ ...BOTH, [PIN_BOX_SETTING]: bad })).toThrow(
      /^RECONCILE_STEWARD_PIN_BOX must be one of the steward’s public keys/,
    );
  });
});

describe('stewardPinsDefine', () => {
  it('defines the pins as null with no setting, so nothing a person sees changes', () => {
    expect(PINS_GLOBAL).toBe('__RECONCILE_STEWARD_PINS__');
    expect(stewardPinsDefine({})).toEqual({ __RECONCILE_STEWARD_PINS__: 'null' });
  });

  it('defines the pins as a JSON object when both are set', () => {
    expect(stewardPinsDefine(BOTH)).toEqual({
      __RECONCILE_STEWARD_PINS__: JSON.stringify({ sign: SIGN, box: BOX }),
    });
  });

  it('throws, failing the build, on a malformed pin', () => {
    expect(() => stewardPinsDefine({ ...BOTH, [PIN_BOX_SETTING]: 'not a key' })).toThrow(
      /RECONCILE_STEWARD_PIN_BOX/,
    );
  });
});
