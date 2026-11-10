/**
 * One click on a submit button acts, even when that click's blur makes a field
 * error appear or clear (#165).
 *
 * Pressing the button blurs the field on mousedown, and React Aria shows or
 * clears the field's error then. If the error line came and went, everything
 * under it moved before mouseup, so the click landed beside the button and did
 * nothing. Each step here types into a field, clicks submit once without
 * blurring first, and checks that the click took effect.
 */
import { acceptNotice, expect, heading, test } from './support/fixtures';

const GROUP = 'Riverside Tenants';
const TITLE = 'House rules';
const LINK_ERROR = 'Use a web link that starts with https:// or http://.';
const TEXT_ERROR = 'Write the new text for this section.';

test('one submit click acts when its blur shows or clears a field error', async ({ page }) => {
  const chat = page.getByRole('textbox', { name: 'Chat link (optional)' });
  const create = page.getByRole('button', { name: 'Create group' });
  const newText = page.getByRole('textbox', { name: 'New text' });
  const propose = page.getByRole('button', { name: 'Propose this change' });

  await test.step('Create group: the click that shows the chat link’s error submits', async () => {
    await page.goto('/#/create');
    await acceptNotice({ name: 'Ana', page });
    await expect(heading(page, 'Create a group')).toBeVisible();
    await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
    await page.getByRole('textbox', { name: 'Your name' }).fill('Ana');
    await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
    await page.getByRole('textbox', { name: 'Document text' }).fill('Quiet hours start at 10pm.');
    await chat.fill('chat.example.org');
    await create.click();
    // Submitting moves focus back to the first invalid field; a lost click leaves it on the button.
    await expect(chat).toBeFocused();
    await expect(page.getByText(LINK_ERROR)).toBeVisible();
  });

  await test.step('Create group: the click that clears it creates the group', async () => {
    await chat.fill('https://chat.example.org/riverside');
    await create.click();
    await expect(heading(page, GROUP)).toBeVisible();
  });

  await test.step('Composer: the click that shows the new text’s error submits', async () => {
    await page.getByRole('link', { name: TITLE }).click();
    await page.getByRole('button', { name: 'Propose a change to section 1' }).click();
    await expect(heading(page, 'Propose a change')).toBeVisible();
    await page.getByRole('textbox', { name: 'Title' }).fill('Later quiet hours on weekends');
    await page.getByRole('textbox', { name: 'Why' }).fill('Weekend evenings run later.');
    // The new text starts as the section's; emptying it is what the blur catches.
    await newText.fill('');
    await propose.click();
    await expect(newText).toBeFocused();
    await expect(page.getByText(TEXT_ERROR)).toBeVisible();
  });

  await test.step('Composer: the click that clears it queues the Proposal', async () => {
    await newText.fill('Quiet hours start at 11pm on weekends.');
    await propose.click();
    await expect(page).toHaveURL(/#\/g\/[\w-]+\/p\/[\w-]+$/);
  });
});
