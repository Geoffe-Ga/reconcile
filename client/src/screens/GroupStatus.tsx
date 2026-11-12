import { messages } from '../app/messages';
import { BackLink, PageHeader } from '../app/ui';

/** Shown for `#/g/{groupId}` when this device isn't in that group. */
export function GroupMissing() {
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={messages.home.missingTitle} pageTitle={messages.home.pageTitle} />
      <p className="lede">{messages.home.missing}</p>
    </main>
  );
}

/**
 * Shown in place of a composer once the group has dissolved (#108), or a
 * vote has removed this member (#115): its copy on this device only reads.
 */
export function GroupArchived({
  groupId,
  name,
  removed = false,
}: {
  readonly groupId: string;
  readonly name: string;
  /** True on the device of a member a vote removed, false for a dissolved group. */
  readonly removed?: boolean;
}) {
  const { readOnlyTitle, readOnly } = removed ? messages.removal : messages.archive;
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId }} label={name} />
      <PageHeader title={readOnlyTitle} pageTitle={messages.home.pageTitle} />
      <p className="lede">{readOnly}</p>
    </main>
  );
}

/**
 * Shown in place of a screen that writes while a restored copy hasn't heard
 * from its group (#231): it may have dissolved since the backup was made.
 */
export function GroupUnconfirmed({
  groupId,
  name,
}: {
  readonly groupId: string;
  readonly name: string;
}) {
  return (
    <main className="shell">
      <BackLink to={{ name: 'group', groupId }} label={name} />
      <PageHeader title={messages.unconfirmed.readOnlyTitle} pageTitle={messages.home.pageTitle} />
      <p className="lede">{messages.unconfirmed.readOnly}</p>
    </main>
  );
}

/**
 * Shown while a group's genesis waits in the outbox: folded state comes from
 * relay records only (spec §7), so the group appears once the relay has it.
 */
export function GroupSettingUp() {
  return (
    <main className="shell">
      <BackLink to={{ name: 'start' }} label={messages.app.yourGroups} />
      <PageHeader title={messages.home.settingUpTitle} pageTitle={messages.home.pageTitle} />
      <p className="lede">{messages.home.settingUp}</p>
    </main>
  );
}
