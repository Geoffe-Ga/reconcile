import { render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ComposeOutcome } from '../app/compose';
import { againDraft, moveDraft, type ProposalValues } from '../app/proposals';
import { LEVELS } from '../engine/capabilities';
import type { GroupState, Proposal } from '../engine/fold';
import type { Draft } from '../store/drafts';
import { axeViolations } from '../test/axe';
import { memoryDrafts } from '../test/drafts';
import { authorOf } from '../test/keys';
import { deadlineOf, groupLog, START_MINUTE } from '../test/votes';
import { MoveComposer } from './MoveComposer';

type OnPropose = (values: ProposalValues) => Promise<ComposeOutcome>;

const [, VOTING] = LEVELS;

/** The device clock the voting time's closing line counts from: Wed 11 Nov 2026, noon UTC. */
const NOW = Date.UTC(2026, 10, 11, 12);
const CHAT = 'https://chat.example.org/riverside';
const ATOMS = ['# Values\n', 'We care for each other.\n', '## Organization\n', 'We meet weekly.\n'];

const box = (name: string) => screen.getByRole('textbox', { name });
const place = () => screen.getByRole('radiogroup', { name: 'Where it goes' });

async function fill(user: UserEvent, entries: Readonly<Record<string, string>>): Promise<void> {
  for (const [label, value] of Object.entries(entries)) {
    await user.clear(box(label));
    if (value === '') continue;
    await user.click(box(label));
    await user.paste(value);
  }
}

interface MoveOptions {
  readonly state?: GroupState;
  /** The section to move, by its index in the first Document (default: the third). */
  readonly atom?: number;
  readonly atomId?: string;
  readonly me?: string;
  readonly drafts?: Readonly<Record<string, Draft>>;
  readonly again?: Proposal;
  readonly leaving?: boolean;
}

/** An outline's group: Values, its words, Organization, its words. */
function outline() {
  return groupLog({ chat: CHAT, atoms: ATOMS });
}

/** Renders Move this section for Atom `atom` and waits for its heading. */
async function moveSection(options: MoveOptions = {}) {
  const state = options.state ?? outline().state();
  const atomId = options.atomId ?? `${state.group ?? ''}.${String(options.atom ?? 2)}`;
  const onPropose = vi.fn<OnPropose>(() => Promise.resolve('proposed'));
  const memory = memoryDrafts(options.drafts);
  render(
    <MoveComposer
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

describe('MoveComposer (#103)', () => {
  it('shows the section as it reads now, then a title, a why, where it goes, a link and the voting time', async () => {
    const { state } = await moveSection();
    expect(screen.getByRole('heading', { level: 1, name: 'Move this section' })).toBeVisible();
    expect(document.title).toBe('Move a section · Reconcile');
    expect(
      screen.getByText(
        'If your group passes it, this section comes out of its place and goes where you choose. Its words stay as they are.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'Section 3 now reads' })).toHaveTextContent(
      'Organization',
    );
    expect(box('Title')).toHaveValue('');
    expect(box('Why')).toHaveValue('');
    expect(box('Discussion link (optional)')).toHaveValue(CHAT);
    expect(screen.getByRole('textbox', { name: 'Voting time (days)' })).toHaveValue('7');
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
    expect(screen.getByRole('button', { name: 'Propose this move' })).toBeEnabled();
    expect(await axeViolations()).toEqual([]);
  });

  it('offers Put it first, then Put it after each other section by its first words, its own spot shown but not chosen', async () => {
    await moveSection();
    const radios = within(place()).getAllByRole('radio');
    const names = [
      'Put it first',
      'Put it after: Values',
      'Put it after: We care for each other.',
      'Put it after: We meet weekly.',
    ];
    expect(radios).toHaveLength(names.length);
    names.forEach((name, i) => {
      expect(within(place()).getByRole('radio', { name })).toBe(radios[i]);
    });
    expect(radios.map((radio) => (radio as HTMLInputElement).disabled)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(radios[2]).toHaveAccessibleDescription('It’s here now.');
    expect(radios[1]).not.toHaveAccessibleDescription('It’s here now.');
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(place().querySelector('bdi')).toHaveTextContent('Values');
  });

  it('shows Put it first as the first section’s own spot, which can’t be chosen', async () => {
    await moveSection({ atom: 0 });
    const first = within(place()).getByRole('radio', { name: /^Put it first/ });
    expect(first).toBeDisabled();
    expect(within(place()).getByText('It’s here now.')).toBeVisible();
    expect(within(place()).queryByRole('radio', { name: /Put it after: Values/ })).toBeNull();
  });

  it('hands over a move after the section chosen, with no text', async () => {
    const { user, state, atomId, onPropose } = await moveSection();
    await fill(user, { Title: ' Organization first ', Why: 'Say how we work first.' });
    await user.click(within(place()).getByRole('radio', { name: 'Put it after: Values' }));
    await user.click(screen.getByRole('button', { name: 'Propose this move' }));
    expect(onPropose).toHaveBeenCalledWith({
      target: { kind: 'move', atom: atomId, after: `${state.group ?? ''}.0` },
      title: 'Organization first',
      why: 'Say how we work first.',
      text: '',
      link: CHAT,
      window: 7,
    });
  });

  it('hands over a move to the start for Put it first', async () => {
    const { user, atomId, onPropose } = await moveSection();
    await fill(user, { Title: 'Organization first', Why: 'It matters most.' });
    await user.click(within(place()).getByRole('radio', { name: 'Put it first' }));
    await user.click(screen.getByRole('button', { name: 'Propose this move' }));
    expect(onPropose.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'move', atom: atomId, after: null },
    });
  });

  it('refuses to send until a place is chosen, with the reason tied to the choice', async () => {
    const { user, onPropose } = await moveSection();
    await fill(user, { Title: 'Organization first', Why: 'It matters most.' });
    await user.click(screen.getByRole('button', { name: 'Propose this move' }));
    expect(onPropose).not.toHaveBeenCalled();
    expect(screen.getByText('Choose where the section goes.')).toBeVisible();
    expect(await axeViolations()).toEqual([]);
  });

  it('starts a carried Dispatch from the Document’s own title', async () => {
    const { user } = await moveSection();
    await user.click(screen.getByRole('checkbox', { name: /Send a Dispatch if this passes/ }));
    expect(box('Dispatch title')).toHaveValue('Updated: House rules');
  });

  it('keeps a private draft under the move’s own key, its place included, and brings it back', async () => {
    const { atomId } = { atomId: `${outline().group}.2` };
    const draft = { title: 'Organization first', why: 'Why.', text: '', link: '', moveAfter: null };
    await moveSection({ drafts: { [moveDraft(atomId)]: draft } });
    expect(await screen.findByText(/Your draft is back/)).toBeVisible();
    expect(box('Title')).toHaveValue('Organization first');
    expect(within(place()).getByRole('radio', { name: 'Put it first' })).toBeChecked();
  });

  it('saves the place chosen into the draft', async () => {
    const { user, atomId, memory, state } = await moveSection();
    await user.click(within(place()).getByRole('radio', { name: 'Put it after: Values' }));
    await vi.waitFor(() => {
      expect(memory.shelf.get(moveDraft(atomId))?.moveAfter).toBe(`${state.group ?? ''}.0`);
    });
  });

  it('offers only sections of the section’s own Document (#92)', async () => {
    const log = groupLog({
      documents: [
        { title: 'Mission statement', atoms: ['We share.\n', 'We meet weekly.\n'] },
        { title: 'House rules', atoms: ['Quiet after 11pm.\n', 'Bins out on Sunday.\n'] },
      ],
    });
    await moveSection({ state: log.state(), atomId: `${log.group}:1.1` });
    expect(within(place()).getAllByRole('radio')).toHaveLength(2);
    expect(
      within(place()).getByRole('radio', { name: 'Put it after: Quiet after 11pm.' }),
    ).toHaveAccessibleDescription('It’s here now.');
    expect(screen.getByRole('link', { name: 'House rules' })).toBeVisible();
  });

  it('says the section has an open Proposal, and shows no form, while one is open on it', async () => {
    const log = outline();
    log.propose('Ana', { atom: 2, text: '## How we organize\n' });
    await moveSection({ state: log.state() });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section has an open Proposal' }),
    ).toBeVisible();
    expect(screen.getByText('You can propose moving it once that vote closes.')).toBeVisible();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('says the section is being moved while a move of it is open', async () => {
    const log = outline();
    log.move('Ana', `${log.group}.2`, null);
    await moveSection({ state: log.state() });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section is being moved' }),
    ).toBeVisible();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('says there’s nowhere to move the only section of a Document', async () => {
    await moveSection({ state: groupLog({ atoms: ['Only this.\n'] }).state(), atom: 0 });
    expect(
      screen.getByRole('heading', { level: 1, name: 'There’s nowhere to move this section' }),
    ).toBeVisible();
    expect(screen.getByText('It’s the only section in its Document.')).toBeVisible();
  });

  it('says a section that isn’t in the Document can’t be moved', async () => {
    await moveSection({ atomId: 'nowhere.0' });
    expect(
      screen.getByRole('heading', { level: 1, name: 'This section isn’t in the Document' }),
    ).toBeVisible();
  });

  it('shows no form to someone who may not propose, nor while their leave waits', async () => {
    const log = groupLog({ atoms: ATOMS, members: ['Ben'], levels: { Ben: VOTING } });
    await moveSection({ state: log.state(), me: authorOf('ben') });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You can’t propose changes here' }),
    ).toBeVisible();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('proposes a lapsed move again from its title, why, link and place, with a fresh window', async () => {
    const log = outline();
    const lapsedMove = log.move('Ana', `${log.group}.2`, null, {
      title: 'Organization first',
      why: 'It matters most.',
      link: 'https://chat.example.org/t/7',
    });
    const state = log.state(deadlineOf(START_MINUTE));
    const again = state.proposals.find((p) => p.id === lapsedMove);
    if (again === undefined) throw new Error('Expected the move.');
    const { user, atomId, onPropose } = await moveSection({ state, again });
    expect(screen.getByRole('heading', { level: 1, name: 'Propose again' })).toBeVisible();
    expect(box('Title')).toHaveValue('Organization first');
    expect(within(place()).getByRole('radio', { name: 'Put it first' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Propose this move' }));
    expect(onPropose).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'move', atom: atomId, after: null },
        title: 'Organization first',
        link: 'https://chat.example.org/t/7',
        again: lapsedMove,
        versions: [],
      }),
    );
    expect(againDraft(lapsedMove)).toBe(`again:${lapsedMove}`);
  });
});
