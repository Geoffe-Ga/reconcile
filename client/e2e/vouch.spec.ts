/**
 * Earning a vote through the real relay (#101; ADR-0014, ADR-0021), with the
 * build served under the deploy CSP: Ana founds a group, and Ben and Cal join
 * and hold voting rights at once, under the bootstrap. Kim joins fourth, so
 * she reads and follows: her own Group home says when her vote arrives, and
 * everyone's People list reads "New · 0 of 2 vouches". Ana vouches for her
 * from People, through the dialog that asks her to have met Kim first and
 * links the group's chat, and once the vouch syncs every device reads "1 of
 * 2 vouches" and "Vouched for by Ana", and Ana is asked for no second one.
 *
 * axe runs, with contrast, on each screen they settle on, and any CSP
 * violation in any page fails the test. Nothing here moves time, so nobody's
 * wait ends.
 */
import {
  acceptNotice,
  expect,
  expectAccessible,
  heading,
  type Person,
  test,
} from './support/fixtures';

const GROUP = 'Riverside Tenants';
const CHAT = 'https://chat.example.org/riverside';
const TITLE = 'House rules';
const ATOMS = ['Quiet hours start at 10pm.', 'Shared spaces are cleaned every Sunday.'];
const WAITING = /^You can vote on Proposals that open after .+, once 2 people vouch for you\.$/;

/** Ana creates the group, with its chat link, and copies an invite link. */
async function found(ana: Person): Promise<string> {
  const { page } = ana;
  await page.goto('/');
  await acceptNotice(ana);
  await page.getByRole('link', { name: 'Create group' }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill(GROUP);
  await page.getByRole('textbox', { name: 'Your name' }).fill(ana.name);
  await page.getByRole('textbox', { name: 'Chat link (optional)' }).fill(CHAT);
  await page.getByRole('textbox', { name: 'Document title' }).fill(TITLE);
  await page.getByRole('textbox', { name: 'Document text' }).fill(ATOMS.join('\n\n'));
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('button', { name: 'Copy invite link' }).click();
  const link = page.getByRole('textbox', { name: 'Invite link' });
  await expect(link).toHaveValue(/#join\/[\w-]{43}$/);
  return link.inputValue();
}

/** Joins from the link at Join's preselected Collaborator, then waits for Group home. */
async function join(person: Person, link: string): Promise<void> {
  const { page } = person;
  await page.goto(link);
  await acceptNotice(person);
  await expect(heading(page, GROUP)).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(person.name);
  await page.getByRole('button', { name: 'Join group' }).click();
  await expect(page).toHaveURL(/#\/g\/[A-Za-z0-9_-]+$/);
}

/** Kim's row on one person's People list. */
function kimRow(person: Person) {
  return person.page
    .getByRole('region', { name: 'People', exact: true })
    .getByRole('listitem')
    .filter({ hasText: /^Kim/ });
}

test('a newcomer reads when their vote arrives, and a vouch for them reaches every device', async ({
  openProfile,
}) => {
  const ana = await openProfile('Ana');
  const ben = await openProfile('Ben');
  const cal = await openProfile('Cal');
  const kim = await openProfile('Kim', { colorScheme: 'dark' });
  let link = '';

  await test.step('Ana founds the group; Ben and Cal join and vote at once', async () => {
    link = await found(ana);
    await join(ben, link);
    await join(cal, link);
    for (const person of [ben, cal]) {
      await expect(person.page.getByText(WAITING)).toHaveCount(0);
    }
  });

  await test.step('Kim joins fourth, and reads when her vote arrives', async () => {
    await join(kim, link);
    const { page } = kim;
    await expect(page.getByText(WAITING)).toBeVisible();
    await expect(
      page.getByText(
        'Voting and proposing start once you have a vote. Until then, you read and follow.',
      ),
    ).toBeVisible();
    await expect(kimRow(kim)).toContainText(/New · 0 of 2 vouches · wait ends /);
    await expect(page.getByRole('button', { name: /^Vouch for/ })).toHaveCount(0);
    await expectAccessible(kim, 'Group home, waiting for a vote');
  });

  await test.step('Ana vouches for Kim from People, through the dialog', async () => {
    const { page } = ana;
    await expect(kimRow(ana)).toContainText(/New · 0 of 2 vouches · wait ends /);
    await expectAccessible(ana, 'Group home, with a newcomer');
    await kimRow(ana).getByRole('button', { name: 'Vouch for Kim' }).click();
    const dialog = page.getByRole('dialog', { name: 'Vouch for Kim?' });
    await expect(dialog).toContainText(
      'Vouch only for someone you’ve met or talked with, on a call or in person. Everyone in the group sees your vouch.',
    );
    await expect(dialog.getByRole('link', { name: /Join discussion/ })).toHaveAttribute(
      'href',
      CHAT,
    );
    await expectAccessible(ana, 'Vouch dialog');
    await dialog.getByRole('button', { name: 'Vouch' }).click();
    await expect(dialog).toBeHidden();
    await expect(kimRow(ana)).toContainText('Vouched for by Ana');
    await expect(kimRow(ana)).toContainText(/New · 1 of 2 vouches/);
    await expect(kimRow(ana).getByRole('button', { name: 'Vouch for Kim' })).toHaveCount(0);
  });

  await test.step('Ben and Kim read the vouch, and Ben may still vouch', async () => {
    await expect(kimRow(ben)).toContainText('Vouched for by Ana');
    await expect(kimRow(ben).getByRole('button', { name: 'Vouch for Kim' })).toBeVisible();
    await expect(kimRow(kim)).toContainText(/New · 1 of 2 vouches/);
    await expect(kim.page.getByText(WAITING)).toBeVisible();
    await expectAccessible(kim, 'Group home, vouched for once');
  });
});
