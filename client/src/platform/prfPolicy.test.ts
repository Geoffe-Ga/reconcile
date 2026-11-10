/**
 * ADR-0030's one version check (#95): PRF isn't trusted on iOS or iPadOS
 * 18.0–18.3, nor on an Apple touch device whose version can't be read.
 * Everywhere else the passkey's own answer decides (ADR-0042).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PlatformEnv } from './installGate';
import { prfTrusted } from './prfPolicy';

type Device = Pick<PlatformEnv, 'userAgent' | 'maxTouchPoints'>;

/** A user agent around `platform`, as Safari writes it, on a device with `touch` points. */
function ua(platform: string, tail = 'Version/18.0 Mobile/15E148 Safari/604.1', touch = 5): Device {
  return {
    userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/605.1.15 (KHTML, like Gecko) ${tail}`,
    maxTouchPoints: touch,
  };
}

/** An iPhone on iOS `major`.`minor`, in Safari. */
const iphone = (major: number, minor: number): Device =>
  ua(
    `iPhone; CPU iPhone OS ${String(major)}_${String(minor)} like Mac OS X`,
    `Version/${String(major)}.${String(minor)} Mobile/15E148 Safari/604.1`,
  );

/** An iPad asking for desktop sites: a Mac's user agent, a touch screen, Safari's `Version/`. */
const ipadDesktop = (version: string): Device =>
  ua('Macintosh; Intel Mac OS X 10_15_7', `Version/${version} Safari/605.1.15`);

describe('prfTrusted', () => {
  it('follows the issue’s examples', () => {
    expect(prfTrusted(ua('iPhone; CPU iPhone OS 18_2 like Mac OS X'))).toBe(false);
    expect(prfTrusted(ua('iPhone; CPU iPhone OS 18_4 like Mac OS X'))).toBe(true);
    expect(prfTrusted(ua('Linux; Android 14', 'Chrome/138.0.0.0 Mobile Safari/537.36'))).toBe(true);
  });

  it.each([0, 1, 2, 3])('is false on iOS 18.%i', (minor) => {
    expect(prfTrusted(iphone(18, minor))).toBe(false);
  });

  it.each([
    [17, 0],
    [17, 7],
    [18, 4],
    [18, 6],
    [19, 0],
    [26, 1],
  ])('is true on iOS %i.%i', (major, minor) => {
    expect(prfTrusted(iphone(major, minor))).toBe(true);
  });

  it('reads the OS version, not Safari’s, in another iOS browser', () => {
    const chrome = ua(
      'iPhone; CPU iPhone OS 18_1 like Mac OS X',
      'CriOS/138.0.7204.119 Mobile/15E148 Safari/604.1',
    );
    expect(prfTrusted(chrome)).toBe(false);
    expect(prfTrusted({ ...chrome, userAgent: chrome.userAgent.replace('18_1', '18_4') })).toBe(
      true,
    );
  });

  it('reads an iPad’s own OS version', () => {
    expect(prfTrusted(ua('iPad; CPU OS 18_3 like Mac OS X'))).toBe(false);
    expect(prfTrusted(ua('iPad; CPU OS 18_4_1 like Mac OS X'))).toBe(true);
  });

  it('reads Version/ on an iPad that asks for desktop sites, whose Mac version is frozen', () => {
    expect(prfTrusted(ipadDesktop('18.2'))).toBe(false);
    expect(prfTrusted(ipadDesktop('18.3'))).toBe(false);
    expect(prfTrusted(ipadDesktop('18.4'))).toBe(true);
    expect(prfTrusted(ipadDesktop('17.6'))).toBe(true);
  });

  it('is false on an Apple touch device whose version can’t be read', () => {
    expect(prfTrusted(ua('Macintosh; Intel Mac OS X 10_15_7', 'Safari/605.1.15'))).toBe(false);
    expect(prfTrusted(ua('iPhone; CPU like Mac OS X', 'Mobile/15E148'))).toBe(false);
  });

  it('is true on a Mac, whose frozen version it never reads', () => {
    expect(
      prfTrusted(ua('Macintosh; Intel Mac OS X 10_15_7', 'Version/18.2 Safari/605.1.15', 0)),
    ).toBe(true);
  });

  it.each([
    ['Android', 'Linux; Android 10; K', 'Chrome/138.0.0.0 Mobile Safari/537.36'],
    ['Windows', 'Windows NT 10.0; Win64; x64', 'Chrome/138.0.0.0 Safari/537.36'],
    ['Linux', 'X11; Linux x86_64', 'Firefox/141.0'],
  ])('is true on %s, whatever it reports', (_name, platform, tail) => {
    expect(prfTrusted(ua(platform, tail, 0))).toBe(true);
  });

  it('is false on iOS exactly from 18.0 to 18.3, for any version an iPhone reports', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 9 }),
        (major, minor) => {
          const buggy = major === 18 && minor <= 3;
          expect(prfTrusted(iphone(major, minor))).toBe(!buggy);
          expect(prfTrusted(ipadDesktop(`${String(major)}.${String(minor)}`))).toBe(!buggy);
        },
      ),
    );
  });
});
