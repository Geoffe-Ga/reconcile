import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { type SyntheticEvent, useState } from 'react';
import { Button, Form } from 'react-aria-components';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseRecord } from '../engine/event';
import { fold } from '../engine/fold';
import { DEFAULT_RULES, type ProposalClass } from '../engine/rules';
import { Composer, type ComposeOutcome } from '../screens/Composer';
import { groupDrafts } from '../store/drafts';
import { testDevice, type TestDevice } from '../test/appServices';
import { axeViolations } from '../test/axe';
import { memoryDrafts } from '../test/drafts';
import { createFakeRelay } from '../test/fakeRelay';
import { freshIndexedDBPerTest } from '../test/idb';
import { authorOf } from '../test/keys';
import { groupLog } from '../test/votes';
import { createGroup } from './actions';
import { propose, type ProposalValues } from './proposals';
import { WindowField } from './WindowField';

freshIndexedDBPerTest();

/** Wed 11 Nov 2026 at noon UTC: the device clock the closing line counts from. */
const NOW = Date.UTC(2026, 10, 11, 12);

const LABEL = 'Voting time (days)';
const RELAY = 'The exact time is set when the relay receives it.';

/** The field's input, found by its label. */
const field = () => screen.getByRole('textbox', { name: LABEL });

interface HarnessProps {
  readonly cls?: ProposalClass;
  readonly start: number;
  readonly onSubmit: (days: number) => void;
}

/** The field alone in a form, holding its value as the composer does, with a submit button. */
function Harness({ cls = 'ordinary', start, onSubmit }: HarnessProps) {
  const [days, setDays] = useState(start);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(days);
  };
  return (
    <Form onSubmit={submit}>
      <WindowField rules={DEFAULT_RULES} cls={cls} value={days} onChange={setDays} now={NOW} />
      <Button type="submit">Send</Button>
    </Form>
  );
}

function renderField(props: Omit<HarnessProps, 'onSubmit'>) {
  const onSubmit = vi.fn<(days: number) => void>();
  render(<Harness {...props} onSubmit={onSubmit} />);
  return { user: userEvent.setup(), onSubmit };
}

async function typeDays(user: UserEvent, days: string): Promise<void> {
  await user.clear(field());
  if (days !== '') await user.type(field(), days);
}

describe('WindowField', () => {
  it('is a number field labelled "Voting time (days)" showing the days chosen', () => {
    renderField({ start: 7 });
    expect(field()).toHaveValue('7');
    expect(field()).toBeRequired();
    expect(field()).toHaveAttribute('inputmode', 'numeric');
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('steps a day at a time and stops at the ordinary bounds, 3 and 14', async () => {
    const { user } = renderField({ start: 4 });
    const fewer = screen.getByRole('button', { name: `Decrease ${LABEL}` });
    const more = screen.getByRole('button', { name: `Increase ${LABEL}` });
    await user.click(fewer);
    expect(field()).toHaveValue('3');
    expect(fewer).toBeDisabled();
    await typeDays(user, '13');
    await user.click(more);
    expect(field()).toHaveValue('14');
    expect(more).toBeDisabled();
    expect(fewer).toBeEnabled();
  });

  it('says from the device clock about when voting closes, tied to the field', async () => {
    const { user } = renderField({ start: 10 });
    expect(field()).toHaveAccessibleDescription(`Closes about Sat 21 Nov. ${RELAY}`);
    await typeDays(user, '3');
    await user.tab();
    expect(field()).toHaveAccessibleDescription(`Closes about Sat 14 Nov. ${RELAY}`);
  });

  it('blocks submit for a window over the bounds, with a message tied to the field', async () => {
    const { user, onSubmit } = renderField({ start: 7 });
    await typeDays(user, '20');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Choose from 3 to 14 days.')).toBeVisible();
    expect(field()).toHaveAccessibleDescription(
      'Voting can run 3 to 14 days, from when the relay receives your Proposal. Choose from 3 to 14 days.',
    );
  });

  it('blocks submit for a window under the bounds, and for none at all', async () => {
    const { user, onSubmit } = renderField({ start: 7 });
    await typeDays(user, '2');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Choose from 3 to 14 days.')).toBeVisible();
    await typeDays(user, '');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Choose from 3 to 14 days.')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('takes whole days only: a decimal point never reaches the field', async () => {
    const { user } = renderField({ start: 7 });
    await typeDays(user, '1.');
    expect(field()).toHaveValue('1');
  });

  it('submits a window inside the bounds, once a refused one is fixed', async () => {
    const { user, onSubmit } = renderField({ start: 7 });
    await typeDays(user, '15');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await typeDays(user, '14');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(14);
    expect(screen.queryByText('Choose from 3 to 14 days.')).not.toBeInTheDocument();
  });

  it('bounds an entrenched change at 14 and 28 days', async () => {
    const { user, onSubmit } = renderField({ cls: 'entrenched', start: 14 });
    expect(screen.getByRole('button', { name: `Decrease ${LABEL}` })).toBeDisabled();
    await typeDays(user, '29');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Choose from 14 to 28 days.')).toBeVisible();
    await typeDays(user, '28');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(28);
    expect(screen.getByRole('button', { name: `Increase ${LABEL}` })).toBeDisabled();
  });
});

describe('WindowField in the composer', () => {
  const devices: TestDevice[] = [];

  afterEach(() => {
    for (const device of devices.splice(0)) device.services.store.close();
  });

  /** Fills the title, why and new text, pasting each as the composer tests do. */
  const titled = async (user: UserEvent) => {
    const entries = { Title: 'Later quiet hours', Why: 'Weekends run late.', 'New text': 'Later.' };
    for (const [name, value] of Object.entries(entries)) {
      const box = screen.getByRole('textbox', { name });
      await user.clear(box);
      await user.click(box);
      await user.paste(value);
    }
  };

  it('offers 3 to 14 days on an edit, with 7 chosen, and passes axe', async () => {
    const state = groupLog().state();
    const drafts = memoryDrafts().drafts;
    render(
      <Composer
        state={state}
        me={authorOf('ana')}
        atomId={`${state.group ?? ''}.0`}
        drafts={drafts}
        now={NOW}
        onPropose={vi.fn()}
        onAddVersion={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 1, name: 'Propose a change' });
    expect(field()).toHaveValue('7');
    expect(field()).toHaveAccessibleDescription(`Closes about Wed 18 Nov. ${RELAY}`);
    const user = userEvent.setup();
    await typeDays(user, '20');
    await user.tab();
    expect(screen.getByText('Choose from 3 to 14 days.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('blocks Propose for 20 days, and queues a proposal with window: 10 once it is 10', async () => {
    const fake = createFakeRelay();
    const ana = await testDevice(fake, 'ana');
    devices.push(ana);
    const created = await createGroup(ana.services, {
      groupName: 'Riverside Tenants',
      yourName: 'Ana',
      chat: null,
      title: 'House rules',
      text: 'Quiet hours start at ten.',
    });
    if (created.outcome !== 'created') throw new Error('Expected a group.');
    const { groupId } = created;
    await ana.services.sync.syncOnce();
    const group = await ana.services.store.getGroup(groupId);
    if (group === undefined) throw new Error('Expected the group.');
    const onPropose = vi.fn(
      async (values: ProposalValues): Promise<ComposeOutcome> =>
        (await propose(ana.services, groupId, values)).outcome,
    );
    fake.offline = true;
    render(
      <Composer
        state={fold(group.log, group.relayNow)}
        me={group.me.author}
        atomId={`${groupId}.0`}
        drafts={groupDrafts(ana.services.store, groupId)}
        now={NOW}
        onPropose={onPropose}
        onAddVersion={vi.fn()}
      />,
    );
    await screen.findByRole('textbox', { name: 'Title' });
    const user = userEvent.setup();
    await titled(user);
    const submit = screen.getByRole('button', { name: 'Propose this change' });

    await typeDays(user, '20');
    await user.click(submit);
    expect(onPropose).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Choose from 3 to 14 days.')).toBeVisible();

    await typeDays(user, '10');
    await user.click(submit);
    await waitFor(async () => {
      expect((await ana.services.store.getGroup(groupId))?.outbox).toHaveLength(1);
    });
    const outbox = (await ana.services.store.getGroup(groupId))?.outbox ?? [];
    const queued = parseRecord(outbox[0] ?? new Uint8Array())?.event;
    expect(queued?.type).toBe('proposal');
    expect(queued?.type === 'proposal' ? queued.body.window : null).toBe(10);
  });

  it('is not on Add your version: the window belongs to the Proposal', async () => {
    const log = groupLog();
    log.propose('ana');
    const state = log.state();
    render(
      <Composer
        state={state}
        me={authorOf('ben')}
        atomId={`${state.group ?? ''}.0`}
        drafts={memoryDrafts().drafts}
        now={NOW}
        onPropose={vi.fn()}
        onAddVersion={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { level: 1, name: 'Add your version' });
    expect(screen.queryByRole('textbox', { name: LABEL })).not.toBeInTheDocument();
  });
});
