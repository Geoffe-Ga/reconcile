/**
 * Reconciling two groups by a card (#114), as the coalition specs do it from
 * outside the app: one person makes the card on their Group home, someone in
 * the other group opens its link and brings it there, and what the card and
 * the coalition's keys leave for the relay scan (`scan.ts`) is named here,
 * derived by Node's own crypto.
 */
import { expect, expectAccessible, heading, type Person, visit } from './fixtures';
import { type Canary, keyCanaries } from './scan';
import { derive, groupMailboxes, type StoredGroup } from './stored';

/** A coalition to propose by card: its name, its first statement's sections, why, and the maker's name in it. */
export interface NewCoalition {
  readonly name: string;
  readonly statement: readonly string[];
  readonly why: string;
  readonly yourName: string;
}

/**
 * From Group home, `person` makes a card for `coalition`, and the link is
 * read from the card's read-only field once the relay holds the card. axe
 * checks the card's form and its link.
 */
export async function makeCard(person: Person, coalition: NewCoalition): Promise<string> {
  const { page } = person;
  const coalitions = page.getByRole('region', { name: 'Coalitions' });
  await coalitions.getByRole('link', { name: /Reconcile with another group/ }).click();
  await expect(heading(page, 'Reconcile with another group')).toBeVisible();
  await expectAccessible(person, 'Reconcile with another group');
  await page.getByRole('textbox', { name: 'The coalition’s name' }).fill(coalition.name);
  await page
    .getByRole('textbox', { name: 'Its first statement' })
    .fill(coalition.statement.join('\n\n'));
  await page.getByRole('textbox', { name: 'Why' }).fill(coalition.why);
  await page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(coalition.yourName);
  await page.getByRole('button', { name: 'Make the card' }).click();
  const link = page.getByRole('textbox', { name: 'Card link' });
  await expect(link).toHaveValue(/^https?:\/\/[^#]+\/#reconcile\/[A-Za-z0-9_-]{43}$/);
  await expect(page.getByText('Anyone who opens this link in the next 2 days')).toBeVisible();
  await expectAccessible(person, 'the card’s link');
  return link.inputValue();
}

/** Where a card is brought: the coalition it names, the group that sent it, and where it goes. */
export interface Bringing {
  readonly coalition: NewCoalition;
  /** The group that made the card. */
  readonly from: string;
  /** The group on this device it's brought to: the only one the device can bring it to. */
  readonly to: string;
  /** The bringer's name in the coalition. */
  readonly yourName: string;
}

/**
 * `person` opens the card `link`, sees it as plain text, brings it to the
 * group `bringing` names, and lands on that group's reconcile Proposal. axe
 * checks Bring.
 */
export async function bringCard(person: Person, link: string, bringing: Bringing): Promise<void> {
  const { page } = person;
  const { coalition } = bringing;
  await visit(page, link);
  await expect(heading(page, coalition.name)).toBeVisible();
  // The card's seed has left the address bar.
  await expect(page).toHaveURL(/#\/card$/);
  for (const section of coalition.statement) await expect(page.getByText(section)).toBeVisible();
  await expect(page.getByText(`From ${bringing.from}`)).toBeVisible();
  const picker = page.getByRole('radiogroup', { name: 'Your group' });
  await expect(picker.getByRole('radio')).toHaveCount(1);
  await expect(picker.getByRole('radio', { name: bringing.to })).toBeChecked();
  await expectAccessible(person, 'Bring a card');
  await page.getByRole('textbox', { name: 'Your name in the coalition' }).fill(bringing.yourName);
  await page.getByRole('button', { name: 'Bring to my group' }).click();
  await expect(heading(page, `Reconcile into ${coalition.name}`)).toBeVisible();
  const statement = page.getByRole('region', { name: 'The coalition’s statement' });
  await expect(statement).toContainText(`Reconcile with ${bringing.from}`);
}

/** What a coalition's keys and card leave for a relay scan. */
export interface CoalitionKeys {
  /** What the relay must never hold: the coalition's secret and seal key, the card's seed and key, and each device's coalition key and entry id. */
  readonly canaries: readonly Canary[];
  /** The coalition's weekly mailbox ids around now: the relay holds its blobs under them. */
  readonly mailboxes: readonly string[];
  /** The card's mailbox id: the relay holds the card under it. */
  readonly cardMailbox: string;
}

/**
 * The canaries and controls for the coalition every one of `entries` holds,
 * one per device, which `cardLink` founded.
 */
export function coalitionKeys(entries: readonly StoredGroup[], cardLink: string): CoalitionKeys {
  const [first] = entries;
  if (first === undefined) throw new Error('Expected at least one device to hold the coalition.');
  const secret = Uint8Array.from(first.secret);
  if (entries.some((entry) => !Buffer.from(entry.secret).equals(Buffer.from(secret)))) {
    throw new Error('Expected every device to hold the same coalition.');
  }
  const seed = Buffer.from(new URL(cardLink).hash.slice('#reconcile/'.length), 'base64url');
  const canaries = [
    ...keyCanaries('the coalition secret', secret),
    ...keyCanaries('the coalition’s seal key', derive(secret, 'reconcile/v1/seal-key')),
    ...keyCanaries('the card seed', seed),
    ...keyCanaries('the card key', derive(seed, 'reconcile/v1/card-key')),
    ...entries.flatMap((each, i) => [
      ...keyCanaries(`coalition key ${String(i + 1)}`, Uint8Array.from(each.signingKey)),
      ...keyCanaries(`coalition id ${String(i + 1)}`, Buffer.from(each.groupId, 'base64url')),
    ]),
  ];
  return {
    canaries,
    mailboxes: groupMailboxes(secret),
    cardMailbox: derive(seed, 'reconcile/v1/card-mailbox').toString('base64url'),
  };
}
