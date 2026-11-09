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
