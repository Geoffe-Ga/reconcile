/**
 * The iOS install gate (ADR-0029, spec §7): on an iPhone or iPad, nothing
 * creates keys until Reconcile runs from the Home Screen.
 *
 * Safari can erase what a site stored after 7 days without a visit, while a
 * Home Screen app keeps its own storage. Every iOS browser and in-app browser
 * runs on Safari's engine, so one rule covers them all. Android and desktop
 * may run in a tab.
 *
 * The rule is a pure function of what the browser reports, so tests can hand
 * it any device.
 */

/** What the gate reads from the browser. */
export interface PlatformEnv {
  /** `navigator.userAgent`. */
  readonly userAgent: string;
  /** `navigator.maxTouchPoints`: above 1 on an iPad, 0 on a Mac. */
  readonly maxTouchPoints: number;
  /** Whether `(display-mode: standalone)` matches: an installed app on iOS 16.4+, Android and desktop. */
  readonly displayModeStandalone: boolean;
  /** Safari's own `navigator.standalone`, when the browser has it. */
  readonly navigatorStandalone: boolean | undefined;
}

/** iPhone, iPad and iPod name themselves. */
const IOS_DEVICE = /iPhone|iPad|iPod/;
const MAC = /Macintosh/;

/**
 * An Apple touch device: an iPhone, iPad or iPod, or an iPad asking for
 * desktop sites, which reports a Mac but has a touch screen (no Mac does).
 */
export function isAppleTouch(env: PlatformEnv): boolean {
  if (IOS_DEVICE.test(env.userAgent)) return true;
  return MAC.test(env.userAgent) && env.maxTouchPoints > 1;
}

/** Running as an installed app, from the Home Screen or an app launcher. */
export function isInstalled(env: PlatformEnv): boolean {
  return env.displayModeStandalone || env.navigatorStandalone === true;
}

/** Whether this browser may create keys: anywhere but an Apple touch device's browser tab. */
export function canCreateKeys(env: PlatformEnv): boolean {
  return !isAppleTouch(env) || isInstalled(env);
}

/** The parts of `window` the gate reads; `standalone` is Safari's alone. */
export interface PlatformSource {
  readonly navigator: {
    readonly userAgent: string;
    readonly maxTouchPoints: number;
    readonly standalone?: unknown;
  };
  readonly matchMedia?: (query: string) => { readonly matches: boolean };
}

/** Reads what the gate needs from the browser, once at startup. */
export function readPlatform(source: PlatformSource = window): PlatformEnv {
  const { userAgent, maxTouchPoints, standalone } = source.navigator;
  return {
    userAgent,
    maxTouchPoints,
    displayModeStandalone: source.matchMedia?.('(display-mode: standalone)').matches ?? false,
    navigatorStandalone: typeof standalone === 'boolean' ? standalone : undefined,
  };
}
