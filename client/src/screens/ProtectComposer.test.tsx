import { render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ComposeOutcome } from '../app/compose';
import { againDraft, protectDraft, type ProposalValues } from '../app/proposals';
import { LEVELS } from '../engine/capabilities';
import type { GroupState, Proposal } from '../engine/fold';
import type { Draft } from '../store/drafts';
import { axeViolations } from '../test/axe';
import { memoryDrafts } from '../test/drafts';
import { authorOf } from '../test/keys';
import { DAY_MINUTES } from '../engine/rules';
import { groupLog, type LogBuilder, START_MINUTE } from '../test/votes';
import { ProtectComposer } from './ProtectComposer';

type OnPropose = (values: ProposalValues) => Promise<ComposeOutcome>;

const [, VOTING] = LEVELS;

/** The device clock the voting time's closing line counts from: Wed 11 Nov 2026, noon UTC. */
const NOW = Date.UTC(2026, 10, 11, 12);
const CHAT = 'https://chat.example.org/riverside';
const PERMANENT = 'This is permanent. Once it passes, the only way out is to leave the group.';

const box = (name: string) => screen.getByRole('textbox', { name });
const choice = () => screen.getByRole('radiogroup', { name: 'Protection' });

async function fill(user: UserEvent, entries: Readonly<Record<string, string>>): Promise<void> {
  for (const [label, value] of Object.entries(entries)) {
    await user.clear(box(label));
    if (value === '') continue;
    await user.click(box(label));
    await user.paste(value);
  }
}

interface ProtectOptions {
  readonly state?: GroupState;
  /** The section to protect, by its index in the first Document (default: the first). */
  readonly atom?: number;
  readonly atomId?: string;
  readonly me?: string;
  readonly drafts?: Readonly<Record<string, Draft>>;
  readonly again?: Proposal;
  readonly leaving?: boolean;
}

/** Riverside Tenants: Ana and Ben, with two sections and a discussion link. */
function riverside(): LogBuilder {
  return groupLog({ chat: CHAT });
}

/** Riverside with its first section made `to` by a passed class Proposal. */
function protectedAs(to: 'entrenched' | 'eternal'): LogBuilder {
  const log = riverside();
  const proposal = log.protect('Ana', `${log.group}.0`, to);
  log.vote('Ana', proposal, 4);
  log.vote('Ben', proposal, 4);
  return log;
}

/** Renders Protect this section for Atom `atom` and waits for its heading. */
async function protect(options: ProtectOptions = {}) {
  const state = options.state ?? riverside().state();
  const atomId = options.atomId ?? `${state.group ?? ''}.${String(options.atom ?? 0)}`;
  const onPropose = vi.fn<OnPropose>(() => Promise.resolve('proposed'));
  const memory = memoryDrafts(options.drafts);
  render(
    <ProtectComposer
      state={state}
      me={options.me ?? authorOf('ana')}
      atomId={atomId}
      drafts={memory.drafts}
      now={NOW}
      onPropose={onPropose}
      leaving={options.leaving ?? false}
      {...(options.again === undefined ? {} : { again: options.again })}
    />,
  );
  await screen.findByRole('heading', { level: 1 });
  return { user: userEvent.setup(), state, atomId, onPropose, memory };
}

describe('ProtectComposer on an ordinary section (#116)', () => {
  it('shows what protecting does and its bar, the section as it reads, then a title, a why, the choice, a link and an entrenched voting time', async () => {
    const { state } = await protect();
    expect(screen.getByRole('heading', { level: 1, name: 'Protect this section' })).toBeVisible();
    expect(document.title).toBe('Protect a section · Reconcile');
    expect(screen.getByText(/A protected section is harder to change\./)).toBeVisible();
    expect(
      screen.getByText(
        'Protecting a section, or removing its protection, needs your group’s higher bar: an average of 3.0 or more, with zeros under 5%.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Section 1 now reads' })).toHaveTextContent(
      'Quiet hours start at ten.',
    );
    expect(box('Title')).toHaveValue('');
    expect(box('Why')).toHaveValue('');
    expect(box('Discussion link (optional)')).toHaveValue(CHAT);
    // A class Proposal is entrenched (ADR-0015 §2): 14 to 28 days, 14 to start.
    expect(screen.getByRole('textbox', { name: 'Voting time (days)' })).toHaveValue('14');
    expect(screen.queryByRole('textbox', { name: /text/i })).not.toBeInTheDocument();
    const fields = Array.from(document.querySelectorAll('form .field, form [role="radiogroup"]'));
    expect(fields.map((field) => field.getAttribute('role') ?? 'field').slice(0, 4)).toEqual([
      'field',
      'field',
      'radiogroup',
      'field',
    ]);
    expect(screen.getByRole('link', { name: 'House rules' })).toHaveAttribute(
      'href',
      `#/g/${state.group ?? ''}/doc/${state.group ?? ''}`,
    );
    expect(screen.getByRole('button', { name: 'Propose this protection' })).toBeEnabled();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Entrenched and Eternal, each with its line, neither chosen to start', async () => {
    await protect();
    const radios = within(choice()).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(within(choice()).getByRole('radio', { name: 'Entrenched' })).toBe(radios[0]);
    expect(within(choice()).getByRole('radio', { name: 'Eternal' })).toBe(radios[1]);
    expect(radios[0]).toHaveAccessibleDescription(
      'Later changes need a higher bar and a longer vote.',
    );
    expect(radios[1]).toHaveAccessibleDescription('No vote can ever change, move or remove it.');
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByText(PERMANENT)).not.toBeInTheDocument();
  });

  it('warns that eternal is permanent once Eternal is chosen, and not for Entrenched', async () => {
    const { user } = await protect();
    await user.click(within(choice()).getByRole('radio', { name: 'Eternal' }));
    const warning = screen.getByText(PERMANENT);
    expect(warning).toBeVisible();
    expect(warning.closest('[aria-live="polite"]')).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
    await user.click(within(choice()).getByRole('radio', { name: 'Entrenched' }));
    expect(screen.queryByText(PERMANENT)).not.toBeInTheDocument();
  });

  it('hands over a class Proposal for the class chosen, with no text and the entrenched default window', async () => {
    const { user, atomId, onPropose } = await protect();
    await fill(user, { Title: ' Protect quiet hours ', Why: 'We rely on them.' });
    await user.click(within(choice()).getByRole('radio', { name: 'Entrenched' }));
    await user.click(screen.getByRole('button', { name: 'Propose this protection' }));
    expect(onPropose).toHaveBeenCalledWith({
      target: { kind: 'class', atom: atomId, to: 'entrenched' },
      title: 'Protect quiet hours',
      why: 'We rely on them.',
      text: '',
      link: CHAT,
      window: 14,
    });
  });

  it('hands over eternal, and a window of 28 days, the longest an entrenched vote runs', async () => {
    const { user, atomId, onPropose } = await protect();
    await fill(user, { Title: 'Forever', Why: 'It is who we are.', 'Voting time (days)': '28' });
    await user.click(within(choice()).getByRole('radio', { name: 'Eternal' }));
    await user.click(screen.getByRole('button', { name: 'Propose this protection' }));
    expect(onPropose.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'class', atom: atomId, to: 'eternal' },
      window: 28,
    });
  });

  it('refuses a voting time under 14 days, which an entrenched vote can’t run', async () => {
    const { user, onPropose } = await protect();
    await fill(user, { Title: 'Protect', Why: 'Why.', 'Voting time (days)': '7' });
    await user.click(within(choice()).getByRole('radio', { name: 'Entrenched' }));
    await user.click(screen.getByRole('button', { name: 'Propose this protection' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(screen.getByText('Choose from 14 to 28 days.')).toBeVisible();
  });

  it('refuses to send until a protection is chosen, with the reason tied to the choice', async () => {
    const { user, onPropose } = await protect();
    await fill(user, { Title: 'Protect quiet hours', Why: 'We rely on them.' });
    await user.click(screen.getByRole('button', { name: 'Propose this protection' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(screen.getByText('Choose how to protect this section.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('starts a carried Dispatch from the Document’s own title', async () => {
    const { user } = await protect();
    await user.click(screen.getByRole('checkbox', { name: /Send a Dispatch if this passes/ }));
    expect(box('Dispatch title')).toHaveValue('Updated: House rules');
  });

  it('keeps a private draft under its own key, the class chosen included, and brings it back', async () => {
    const atomId = `${riverside().group}.0`;
    const draft = { title: 'Forever', why: 'Why.', text: '', link: '', classTo: 'eternal' };
    await protect({ drafts: { [protectDraft(atomId)]: draft } });
    expect(await screen.findByText(/Your draft is back/)).toBeVisible();
    expect(box('Title')).toHaveValue('Forever');
    expect(within(choice()).getByRole('radio', { name: 'Eternal' })).toBeChecked();
    expect(screen.getByText(PERMANENT)).toBeVisible();
  });

  it('saves the class chosen into the draft', async () => {
    const { user, atomId, memory } = await protect();
    await user.click(within(choice()).getByRole('radio', { name: 'Entrenched' }));
    await vi.waitFor(() => {
      expect(memory.shelf.get(protectDraft(atomId))?.classTo).toBe('entrenched');
    });
  });

  it('protects a section of the group’s second Document, and Back goes there (#92)', async () => {
    const log = groupLog({
      documents: [
        { title: 'Mission statement', atoms: ['We share.\n'] },
        { title: 'Values', atoms: ['We care for each other.\n'] },
      ],
    });
    await protect({ state: log.state(), atomId: `${log.group}:1.0` });
    expect(screen.getByRole('link', { name: 'Values' })).toHaveAttribute(
      'href',
      `#/g/${log.group}/doc/${log.group}:1`,
    );
  });
});

describe('ProtectComposer on an entrenched section (#116)', () => {
  it('offers Make it eternal and Remove the protection, and names the change', async () => {
    const state = protectedAs('entrenched').state();
    await protect({ state });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Change this section’s protection' }),
    ).toBeVisible();
    const radios = within(choice()).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(within(choice()).getByRole('radio', { name: 'Make it eternal' })).toBe(radios[0]);
    expect(within(choice()).getByRole('radio', { name: 'Remove the protection' })).toBe(radios[1]);
    expect(radios[1]).toHaveAccessibleDescription(
      'Later changes go back to the usual bar and vote.',
    );
    expect(screen.getByText('Entrenched')).toHaveClass('atom-badge-entrenched');
    expect(await axeViolations()).toEqual([]);
  });

  it('warns that Make it eternal is permanent, and hands over eternal', async () => {
    const { user, atomId, onPropose } = await protect({
      state: protectedAs('entrenched').state(),
    });
    await user.click(within(choice()).getByRole('radio', { name: 'Make it eternal' }));
    expect(screen.getByText(PERMANENT)).toBeVisible();
    await fill(user, { Title: 'Forever', Why: 'It is who we are.' });
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'class', atom: atomId, to: 'eternal' },
    });
  });

  it('hands over ordinary for Remove the protection, with no warning', async () => {
    const { user, atomId, onPropose } = await protect({
      state: protectedAs('entrenched').state(),
    });
    await user.click(within(choice()).getByRole('radio', { name: 'Remove the protection' }));
    expect(screen.queryByText(PERMANENT)).not.toBeInTheDocument();
    await fill(user, { Title: 'Unprotect', Why: 'It changes often.' });
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'class', atom: atomId, to: 'ordinary' },
      window: 14,
    });
  });

  it('refuses to send until a choice is made, in the words of a change', async () => {
    const { user, onPropose } = await protect({ state: protectedAs('entrenched').state() });
    await fill(user, { Title: 'Change', Why: 'Why.' });
    await user.click(screen.getByRole('button', { name: 'Propose this change' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(screen.getByText('Choose what happens to this section’s protection.')).toBeVisible();
  });
});

describe('ProtectComposer with no form (#116)', () => {
  it('says an eternal section can’t be changed, and shows no form', async () => {
    await protect({ state: protectedAs('eternal').state() });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section is eternal' }),
    ).toBeVisible();
    expect(
      screen.getByText('No vote can change, move or remove it, or its protection.'),
    ).toBeVisible();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('says the section has an open Proposal while one is open on it', async () => {
    const log = riverside();
    log.propose('Ana', { atom: 0, text: 'Quiet after 11pm.' });
    await protect({ state: log.state() });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section has an open Proposal' }),
    ).toBeVisible();
    expect(screen.getByText('You can propose protecting it once that vote closes.')).toBeVisible();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('says the section’s protection is being decided while a class Proposal is open on it', async () => {
    const log = riverside();
    log.protect('Ana', `${log.group}.0`, 'eternal');
    await protect({ state: log.state() });
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'This section’s protection is being decided',
      }),
    ).toBeVisible();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('says a section that isn’t in the Document can’t be protected', async () => {
    await protect({ atomId: 'nowhere.0' });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section isn’t in the Document' }),
    ).toBeVisible();
  });

  it('shows no form to someone who may not propose, nor while their leave waits', async () => {
    const log = groupLog({ members: ['Ben'], levels: { Ben: VOTING } });
    await protect({ state: log.state(), me: authorOf('ben') });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose changes here' }),
    ).toBeVisible();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });
});

describe('ProtectComposer proposing again (#116, #74)', () => {
  it('proposes a lapsed class Proposal again from its title, why, link and choice, with a fresh window', async () => {
    const log = riverside();
    const lapsedProtect = log.protect('Ana', `${log.group}.0`, 'eternal', {
      title: 'Forever',
      why: 'It is who we are.',
      link: 'https://chat.example.org/t/7',
    });
    const state = log.state(START_MINUTE + 14 * DAY_MINUTES);
    const again = state.proposals.find((p) => p.id === lapsedProtect);
    if (again === undefined) throw new Error('Expected the class Proposal.');
    expect(again.outcome.kind).toBe('lapse');
    const { user, atomId, onPropose } = await protect({ state, again });
    expect(screen.getByRole('heading', { level: 1, name: 'Propose again' })).toBeVisible();
    expect(box('Title')).toHaveValue('Forever');
    expect(within(choice()).getByRole('radio', { name: 'Eternal' })).toBeChecked();
    expect(screen.getByText(PERMANENT)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Propose this protection' }));
    expect(onPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'class', atom: atomId, to: 'eternal' },
        title: 'Forever',
        link: 'https://chat.example.org/t/7',
        again: lapsedProtect,
        versions: [],
      }),
    );
    expect(againDraft(lapsedProtect)).toBe(`again:${lapsedProtect}`);
  });
});
