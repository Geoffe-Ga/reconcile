/**
 * What makes Reconcile installable (#76): the web app manifest in public/,
 * which the build copies as is, the icons it names, and index.html's links.
 */
import { describe, expect, it } from 'vitest';

import indexHtml from '../../../index.html?raw';
import manifestText from '../../../public/manifest.webmanifest?raw';

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: string;
}

const manifest = JSON.parse(manifestText) as Record<string, unknown>;
const icons = manifest.icons as ManifestIcon[];

/** The PNGs in public/icons/, by their URL in the build. */
const SHIPPED_ICONS = Object.keys(import.meta.glob('/public/icons/*.png')).map((path) =>
  path.replace(/^\/public/, ''),
);

const page = new DOMParser().parseFromString(indexHtml, 'text/html');

describe('the web app manifest', () => {
  it('opens the whole app, from its root, as a standalone app', () => {
    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      name: 'Reconcile',
      short_name: 'Reconcile',
    });
  });

  it('starts at / with no query or fragment, so no secret can ride in the start URL', () => {
    const start = new URL(String(manifest.start_url), 'https://reconcile.example');
    expect(start.pathname).toBe('/');
    expect(start.search).toBe('');
    expect(start.hash).toBe('');
  });

  it('names a 192, a 512 and a maskable 512 icon, each one shipped', () => {
    expect(icons.map(({ sizes, purpose }) => `${sizes} ${purpose}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
    for (const icon of icons) {
      expect(icon.type).toBe('image/png');
      expect(SHIPPED_ICONS).toContain(icon.src);
    }
  });

  it('paints the splash screen in the warm paper canvas', () => {
    expect(manifest.background_color).toBe('#f6f1e7');
    expect(manifest.theme_color).toBe('#f6f1e7');
  });
});

describe('index.html', () => {
  it('links the manifest and the Home Screen icon iOS reads, all from the app’s origin', () => {
    const manifestLink = page.querySelector('link[rel="manifest"]');
    expect(manifestLink?.getAttribute('href')).toBe('/manifest.webmanifest');
    const touchIcon = page.querySelector('link[rel="apple-touch-icon"]');
    expect(touchIcon?.getAttribute('href')).toBe('/icons/apple-touch-icon-180.png');
    expect(SHIPPED_ICONS).toContain('/icons/apple-touch-icon-180.png');
    const title = page.querySelector('meta[name="apple-mobile-web-app-title"]');
    expect(title?.getAttribute('content')).toBe('Reconcile');
  });

  it('has no inline script, which the CSP would block', () => {
    const scripts = [...page.querySelectorAll('script')];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.getAttribute('src')).not.toBeNull();
      expect(script.textContent.trim()).toBe('');
    }
  });
});
