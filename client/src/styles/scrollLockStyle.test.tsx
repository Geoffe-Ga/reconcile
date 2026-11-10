import { render, screen } from '@testing-library/react';
import { Dialog, Heading, Modal } from 'react-aria-components';
import { afterEach, describe, expect, it, vi } from 'vitest';

import viteConfig from '../../vite.config.ts?raw';

/*
 * On iOS and iPadOS, React Aria's usePreventScroll prepends an inline <style>
 * to <head> while a Modal or a modal Popover (Select, ComboBox, Menu,
 * DatePicker) is open. It has no id, so it can't be claimed as the pressable
 * style is (pressable.test.tsx, #150). The deploy CSP allows that exact text by
 * its hash in style-src-elem instead (#153). These tests hash the text the
 * installed React Aria really injects and pin the policy to it: an upgrade that
 * changes one byte fails here, not on members' iPhones. jsdom doesn't enforce
 * CSP; e2e/ios-scroll-lock.spec.ts shows a browser applying the policy.
 */

/** What to do when one of these tests fails, most likely after a React Aria upgrade. */
const ON_UPGRADE =
  'React Aria’s iOS scroll-lock <style> no longer matches the hash the deploy CSP allows (#153). ' +
  'Re-read its usePreventScroll. If it no longer injects a <style>, remove the hash. If the text ' +
  'changed but is still one fixed rule, put the hash this test expects in style-src-elem in ' +
  'deploy/Caddyfile and client/vite.config.ts, which deploy/check.sh keeps equal.';

/** What to do when the injected style gains an id. */
const NOW_CLAIMABLE =
  'React Aria’s iOS scroll-lock <style> now has an id. Claim it in index.html as the pressable ' +
  'style is (#150), and drop its hash from the CSP.';

/** What React Aria's isIOS() and isWebKit() read: navigator.platform, touch points and the user agent. */
interface Device {
  readonly platform: string;
  readonly maxTouchPoints: number;
  readonly userAgent: string;
}

const DEVICES = {
  iPhone: {
    platform: 'iPhone',
    maxTouchPoints: 5,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  },
  // iPadOS 13 and later says it's a Mac; React Aria tells it apart by its touch points.
  iPad: {
    platform: 'MacIntel',
    maxTouchPoints: 5,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  },
  'desktop Safari': {
    platform: 'MacIntel',
    maxTouchPoints: 0,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  },
} satisfies Record<string, Device>;

/**
 * Makes navigator read as `device`. React Aria checks the platform on every
 * call under NODE_ENV 'test' (it caches the answer only in a build).
 */
function emulate(device: Device): void {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(device.platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(device.userAgent);
  // jsdom has no maxTouchPoints to spy on.
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    get: () => device.maxTouchPoints,
  });
}

/** Opens a React Aria Modal, as a screen with a dialog would, and waits for its dialog. */
function openModal(): void {
  render(
    <Modal isOpen>
      <Dialog>
        <Heading slot="title">Leave this group?</Heading>
      </Dialog>
    </Modal>,
  );
  expect(screen.getByRole('dialog', { name: 'Leave this group?' })).toBeInTheDocument();
}

/** The deploy CSP's directives, as vite.config.ts serves them under `vite preview`. */
function deployCsp(): Map<string, string[]> {
  const policy = /'Content-Security-Policy':\s*"([^"]*)"/.exec(viteConfig)?.[1];
  if (policy === undefined) {
    throw new Error('client/vite.config.ts no longer sets a Content-Security-Policy header.');
  }
  return new Map(
    policy.split(';').map((directive) => {
      const [name = '', ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

/** The CSP source that allows an inline `<style>` holding exactly `text`. */
async function hashSource(text: string): Promise<string> {
  const bytes = Uint8Array.from(new TextEncoder().encode(text));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
}

describe('React Aria’s iOS scroll-lock style under the deploy CSP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'maxTouchPoints');
  });

  it.each(['iPhone', 'iPad'] as const)(
    'on an %s, an open Modal adds one id-less <style>, and style-src-elem allows exactly its hash',
    async (device) => {
      emulate(DEVICES[device]);

      openModal();

      const styles = [...document.head.querySelectorAll('style')];
      expect(styles, ON_UPGRADE).toHaveLength(1);
      expect(styles[0]?.id, NOW_CLAIMABLE).toBe('');
      const allowed = ["'self'", await hashSource(styles[0]?.textContent ?? '')];
      expect(deployCsp().get('style-src-elem'), ON_UPGRADE).toEqual(allowed);
    },
  );

  it('on desktop Safari, an open Modal adds no <style>, so only iOS and iPadOS need the hash', () => {
    emulate(DEVICES['desktop Safari']);

    openModal();

    expect(
      document.head.querySelectorAll('style'),
      'React Aria now injects its scroll-lock <style> off iOS too. The hash still allows it; ' +
        'update the docs that say it is iOS only (deploy/README.md, The CSP).',
    ).toHaveLength(0);
  });

  it('allows no other inline style: no style-src or style-src-attr, and nothing unsafe', () => {
    const csp = deployCsp();

    expect([...csp.keys()].filter((name) => name.startsWith('style-src'))).toEqual([
      'style-src-elem',
    ]);
    expect([...csp.values()].flat().filter((source) => source.startsWith("'unsafe-"))).toEqual([]);
  });
});
