/**
 * Search from the link bar (#445), end to end through the real relay: Ana
 * is in two groups. From Oak St's home she types a few words of a section
 * of Riverside's Document, sees it under Documents with where it's from,
 * with axe on the open results, and Enter lands her on that section, on a
 * desktop and on a dark phone.
 */
import {
  acceptNotice,
  expect,
  expectAccessible,
  foundGroup,
  heading,
  test,
} from './support/fixtures';

const SECTION = 'Bins go out on Tuesday.';

test('a person in two groups finds a section of one from the other, and lands on it', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana');
  const { page } = ana;
  let oak = '';

  await test.step('Ana founds Riverside and Oak St', async () => {
    await page.goto('/');
    await acceptNotice(ana);
    await foundGroup(page, {
      name: 'Riverside Tenants',
      title: 'House rules',
      atoms: ['Quiet hours start at ten.', SECTION],
      founder: 'Ana',
    });
    await page.goto('/#/');
    await expect(heading(page, 'Your groups')).toBeVisible();
    await foundGroup(page, {
      name: 'Oak St',
      title: 'Our agreement',
      atoms: ['We share the garden.'],
      founder: 'Ana',
    });
    await expect(heading(page, 'Oak St')).toBeVisible();
    oak = page.url();
  });

  const places = [
    ['a desktop', { width: 1280, height: 800 }, 'light'],
    ['a dark phone', { width: 390, height: 844 }, 'dark'],
  ] as const;
  for (const [where, size, colorScheme] of places) {
    await test.step(`on ${where}, she finds Riverside's section from Oak St's home and lands on it`, async () => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme });
      await page.goto(oak);
      await expect(heading(page, 'Oak St')).toBeVisible();
      await page.keyboard.press('/');
      const bar = page.getByRole('searchbox', { name: 'Search or paste a link' });
      await expect(bar).toBeFocused();
      await page.keyboard.type('bins tues');
      const results = page.getByRole('listbox', { name: 'Results' });
      await expect(results.getByText('Documents', { exact: true })).toBeVisible();
      const [first] = await results.getByRole('option').all();
      await expect(first ?? results).toContainText('House rules');
      await expect(first ?? results).toContainText('Riverside Tenants');
      await expectAccessible(ana, `search results on ${where}`);

      await page.keyboard.press('Enter');

      await expect(heading(page, 'House rules')).toBeVisible();
      await expect(page).toHaveURL(/#\/g\/[\w-]+\/doc\/[\w-]+$/u);
      await expect(page.getByText(SECTION, { exact: true })).toBeInViewport();
      await expect(bar).toHaveValue('');
    });
  }
});
