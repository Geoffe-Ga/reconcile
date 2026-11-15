/**
 * The landing page (ADR-0077): what a new visitor sees before first run.
 *
 * On a phone and on a desktop, a plain visit opens on it. It passes axe, loads
 * its painting from the app's own origin under the deploy CSP, stores nothing,
 * and its Start a Group button moves on to the pilot notice. Its top links
 * move down the page without touching the address bar, where routes live.
 * Once the notice is accepted, the same address opens the app, and Start
 * shows the painting only at its edges.
 */
import {
  acceptNotice,
  expect,
  expectAccessible,
  heading,
  storedRecords,
  test,
} from './support/fixtures';

const SIZES = {
  'a phone': { width: 390, height: 844 },
  'a desktop': { width: 1440, height: 900 },
};

for (const [name, viewport] of Object.entries(SIZES)) {
  test(`${name} opens on the landing page, which stores nothing and leads into first run`, async ({
    openProfile,
  }) => {
    const ana = await openProfile('Ana', { viewport });
    const { page } = ana;
    const painted: string[] = [];
    page.on('response', (response) => {
      const { pathname } = new URL(response.url());
      if (pathname.startsWith('/painting/') && response.ok()) painted.push(pathname);
    });

    await test.step('a plain visit shows the landing page', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Reconcile' })).toBeVisible();
      await expect(heading(page, 'Before you start')).toHaveCount(0);
      await expectAccessible(ana, 'landing page');
      expect(await storedRecords(page)).toBe(0);
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
    });

    await test.step('its painting comes from the app’s own origin', async () => {
      const layout = viewport.width >= 1200 ? 'wide' : 'tall';
      await expect.poll(() => painted).toContain(`/painting/${layout}/sky.webp`);
      expect(painted.every((path) => path.startsWith(`/painting/${layout}/`))).toBe(true);
    });

    await test.step('a top link moves to its section and leaves the address bar alone', async () => {
      const nav = page.getByRole('navigation', { name: 'On this page' });
      await nav.getByRole('button', { name: 'Privacy' }).click();
      const section = page.getByRole('heading', {
        level: 2,
        name: 'A map of who believes what is worth a lot.',
      });
      await expect(section).toBeFocused();
      await expect(section).toBeInViewport();
      expect(new URL(page.url()).hash).toBe('');
    });

    await test.step('Start a Group moves on to the pilot notice, then Start', async () => {
      await acceptNotice(ana);
      await expect(heading(page, 'Your groups')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Reconcile' })).toHaveCount(0);
    });

    await test.step('Start shows the painting only at its edges, and still passes axe', async () => {
      const shell = page.getByRole('main');
      await expect(shell).toHaveAttribute('data-scene', 'sky');
      const edge = await shell.evaluate(
        (main) => getComputedStyle(main, '::before').backgroundImage,
      );
      expect(edge).toContain('/edges/sky.webp');
      await expectAccessible(ana, 'Start, with its painted edge');
    });

    await test.step('a return visit opens the app, not the landing page', async () => {
      await page.reload();
      await expect(heading(page, 'Your groups')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Reconcile' })).toHaveCount(0);
    });
  });
}
