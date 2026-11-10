import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canCreateKeys,
  isAppleTouch,
  isInstalled,
  type PlatformEnv,
  readPlatform,
} from './installGate';

const ios = (browser: string): string =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser}`;

/** iPadOS asks for desktop sites, so its Safari reports a Mac. */
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

const UA = {
  iphoneSafari: ios('Version/18.5 Mobile/15E148 Safari/604.1'),
  criOS: ios('CriOS/138.0.7204.119 Mobile/15E148 Safari/604.1'),
  fxiOS: ios('FxiOS/141.0 Mobile/15E148 Safari/605.1.15'),
  edgiOS: ios('Version/18.0 EdgiOS/138.3351.83 Mobile/15E148 Safari/605.1.15'),
  facebook: ios(
    'Mobile/22F76 [FBAN/FBIOS;FBAV/520.0.0.38.101;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.5;FBLC/en_US]',
  ),
  ipadLegacy:
    'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  ipod: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  macSafari: MAC_SAFARI,
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
} as const;

/** A browser tab: not running from the Home Screen. */
function tab(userAgent: string, maxTouchPoints: number): PlatformEnv {
  return {
    userAgent,
    maxTouchPoints,
    displayModeStandalone: false,
    navigatorStandalone: undefined,
  };
}

describe('canCreateKeys', () => {
  it('follows the issue’s example: an iPad tab, a Mac, and an installed iPad', () => {
    const env = tab(MAC_SAFARI, 5);
    expect(canCreateKeys(env)).toBe(false); // iPad, browser tab
    expect(canCreateKeys({ ...env, maxTouchPoints: 0 })).toBe(true); // a Mac
    expect(canCreateKeys({ ...env, displayModeStandalone: true })).toBe(true); // installed
  });

  it.each([
    ['iPhone Safari', tab(UA.iphoneSafari, 5)],
    ['iPadOS Safari with touch', tab(UA.macSafari, 5)],
    ['Chrome on iOS (CriOS)', tab(UA.criOS, 5)],
    ['Firefox on iOS (FxiOS)', tab(UA.fxiOS, 5)],
    ['Edge on iOS (EdgiOS)', tab(UA.edgiOS, 5)],
    ['an in-app browser (FBIOS)', tab(UA.facebook, 5)],
    ['an older iPad', tab(UA.ipadLegacy, 5)],
    ['an iPod touch', tab(UA.ipod, 5)],
  ])('keeps %s from creating keys until it is installed', (_name, env) => {
    expect(isAppleTouch(env)).toBe(true);
    expect(isInstalled(env)).toBe(false);
    expect(canCreateKeys(env)).toBe(false);
    expect(canCreateKeys({ ...env, displayModeStandalone: true })).toBe(true);
    expect(canCreateKeys({ ...env, navigatorStandalone: true })).toBe(true);
  });

  it.each([
    ['Android Chrome', tab(UA.androidChrome, 5)],
    ['desktop Chrome', tab(UA.desktopChrome, 0)],
    ['a Windows touch screen', tab(UA.desktopChrome, 10)],
    ['Safari on a Mac', tab(UA.macSafari, 0)],
    ['Chrome on a Mac', tab(UA.macChrome, 0)],
  ])('lets %s create keys in a tab', (_name, env) => {
    expect(isAppleTouch(env)).toBe(false);
    expect(canCreateKeys(env)).toBe(true);
  });

  it('counts a Mac as a touch device only above one touch point', () => {
    expect(isAppleTouch(tab(UA.macSafari, 1))).toBe(false);
    expect(isAppleTouch(tab(UA.macSafari, 2))).toBe(true);
  });

  it('reads navigator.standalone only when it is exactly true', () => {
    const env = tab(UA.iphoneSafari, 5);
    expect(isInstalled({ ...env, navigatorStandalone: false })).toBe(false);
    expect(isInstalled({ ...env, navigatorStandalone: true })).toBe(true);
  });
});

describe('readPlatform', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the user agent, touch points and both standalone signals', () => {
    const matchMedia = vi.fn((query: string) => ({
      matches: query === '(display-mode: standalone)',
    }));
    const env = readPlatform({
      navigator: { userAgent: UA.iphoneSafari, maxTouchPoints: 5, standalone: true },
      matchMedia,
    });
    expect(env).toEqual({
      userAgent: UA.iphoneSafari,
      maxTouchPoints: 5,
      displayModeStandalone: true,
      navigatorStandalone: true,
    });
    expect(matchMedia).toHaveBeenCalledWith('(display-mode: standalone)');
  });

  it('treats a missing matchMedia and a non-boolean standalone as not installed', () => {
    const env = readPlatform({
      navigator: { userAgent: UA.desktopChrome, maxTouchPoints: 0, standalone: 'yes' },
    });
    expect(env.displayModeStandalone).toBe(false);
    expect(env.navigatorStandalone).toBeUndefined();
  });

  it('reads the real window by default', () => {
    const env = readPlatform();
    expect(env.userAgent).toBe(navigator.userAgent);
    expect(env.displayModeStandalone).toBe(false);
  });
});
