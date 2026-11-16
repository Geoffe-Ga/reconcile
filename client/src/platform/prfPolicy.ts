/**
 * Whether to trust a passkey's PRF output on this device (ADR-0030, #95).
 *
 * Apple's 18.0–18.3 releases offer PRF with known bugs that could lose data,
 * so there it isn't used even when offered: on iOS and iPadOS, and in Safari
 * 18.0–18.3 on a Mac (#389). That is the app's one version check (ADR-0042):
 * everywhere else the passkey's own answer at the first sign-in decides.
 *
 * - An iPhone or iPad names its OS version in `OS 18_2`. An iPad that asks
 *   for desktop sites reports a Mac, whose version is frozen at 10_15, so on
 *   an Apple touch device that names no OS version, Safari's `Version/18.2`
 *   stands in. An Apple touch device with neither isn't trusted.
 * - A Mac's frozen 10_15 says nothing either, so Safari's own `Version/`
 *   stands in there too, read only beside Safari's token and no other
 *   browser's. Chrome, Edge, Firefox and Opera name no Safari version, so
 *   their passkeys' own answers decide, as on Windows.
 */
import { isAppleTouch, type PlatformEnv } from './installGate';

/** `CPU iPhone OS 18_2` on an iPhone or iPod, `CPU OS 18_2` on an iPad. Never a Mac's `Mac OS X 10_15`. */
const OS_VERSION = /\bCPU (?:iPhone )?OS (\d+)_(\d+)/;

/** Safari's own version, which follows the OS's. */
const SAFARI_VERSION = /\bVersion\/(\d+)\.(\d+)/;

/** Another browser's token: a user agent with one isn't Safari, whatever else it says. */
const NOT_SAFARI = /\b(?:Chrome|Chromium|CriOS|Edg|EdgiOS|Firefox|FxiOS|OPR|OPT)\//;

/** Safari's own token, which every Safari user agent ends with. */
const SAFARI = /\bSafari\//;

/** A Mac's user agent, frozen at `Intel Mac OS X 10_15_7`. */
const MAC = /\bMacintosh\b/;

/** The first release with the PRF bugs, and the last. */
const BUGGY_MAJOR = 18;
const LAST_BUGGY_MINOR = 3;

/** The major and minor version `pattern` reads from `userAgent`, or null. */
function versionIn(userAgent: string, pattern: RegExp): readonly [number, number] | null {
  const match = pattern.exec(userAgent);
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

/** Whether `version` is one of the releases with the PRF bugs, 18.0 to 18.3. */
function buggy([major, minor]: readonly [number, number]): boolean {
  return major === BUGGY_MAJOR && minor <= LAST_BUGGY_MINOR;
}

/** Safari's own version on a Mac, or null in another browser or on another computer. */
function macSafariVersion(userAgent: string): readonly [number, number] | null {
  if (!MAC.test(userAgent) || !SAFARI.test(userAgent) || NOT_SAFARI.test(userAgent)) return null;
  return versionIn(userAgent, SAFARI_VERSION);
}

/**
 * False on an iPhone, iPad or iPod running 18.0 to 18.3, or one whose version
 * can't be read, and in Safari 18.0 to 18.3 on a Mac (#389); true everywhere
 * else.
 */
export function prfTrusted(env: Pick<PlatformEnv, 'userAgent' | 'maxTouchPoints'>): boolean {
  if (!isAppleTouch(env)) {
    const safari = macSafariVersion(env.userAgent);
    return safari === null || !buggy(safari);
  }
  const version = versionIn(env.userAgent, OS_VERSION) ?? versionIn(env.userAgent, SAFARI_VERSION);
  return version !== null && !buggy(version);
}
