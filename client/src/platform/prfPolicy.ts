/**
 * Whether to trust a passkey's PRF output on this device (ADR-0030, #95).
 *
 * iOS and iPadOS 18.0–18.3 offer PRF with known bugs that could lose data, so
 * there it isn't used even when offered. That is the app's one version check
 * (ADR-0042): everywhere else the passkey's own answer at the first sign-in
 * decides. An iPhone or iPad names its OS version in `OS 18_2`; an iPad that
 * asks for desktop sites reports a Mac, whose version is frozen at 10_15, so
 * on an Apple touch device that names no OS version, Safari's `Version/18.2`
 * stands in. An Apple touch device with neither isn't trusted.
 */
import { isAppleTouch, type PlatformEnv } from './installGate';

/** `CPU iPhone OS 18_2` on an iPhone or iPod, `CPU OS 18_2` on an iPad. Never a Mac's `Mac OS X 10_15`. */
const OS_VERSION = /\bCPU (?:iPhone )?OS (\d+)_(\d+)/;

/** Safari's own version, which follows the OS's. */
const SAFARI_VERSION = /\bVersion\/(\d+)\.(\d+)/;

/** The first release with the PRF bugs, and the last. */
const BUGGY_MAJOR = 18;
const LAST_BUGGY_MINOR = 3;

/** The major and minor version `pattern` reads from `userAgent`, or null. */
function versionIn(userAgent: string, pattern: RegExp): readonly [number, number] | null {
  const match = pattern.exec(userAgent);
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

/**
 * False on an iPhone, iPad or iPod running 18.0 to 18.3, or one whose version
 * can't be read; true everywhere else.
 */
export function prfTrusted(env: Pick<PlatformEnv, 'userAgent' | 'maxTouchPoints'>): boolean {
  if (!isAppleTouch(env)) return true;
  const version = versionIn(env.userAgent, OS_VERSION) ?? versionIn(env.userAgent, SAFARI_VERSION);
  if (version === null) return false;
  const [major, minor] = version;
  return major !== BUGGY_MAJOR || minor > LAST_BUGGY_MINOR;
}
