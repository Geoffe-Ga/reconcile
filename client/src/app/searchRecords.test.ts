/**
 * What search reads (#445): the records a device's folded groups,
 * coalitions and personal Documents give it, and the app's own places, each
 * with where it's from and where it opens. Never a ballot's note, a
 * person's name, or anything of an archive beyond its Documents.
 */
import { describe, expect, it } from 'vitest';

import { testGroup } from '../test/groups';
import { groupLog } from '../test/votes';
import { search } from './search';
import { recordsOf } from './searchRecords';

const NOTE = 'CANARYNOTE';

/** A group Ana founded with one Document of two sections, a Proposal, and Ben's ballot note on it. */
function riverside() {
  const log = groupLog({ members: ['Ben'] });
  const proposal = log.propose('Ana', {
    atom: 0,
    title: 'Later quiet hours',
    why: 'Weekends run late.',
    text: 'Quiet hours start at eleven.',
  });
  log.vote('Ben', proposal, 0, `${NOTE} is why`);
  return { groupId: 'riverside', state: log.state(), proposal, archived: false };
}

describe('recordsOf', () => {
  it('reads a group: its name, its Documents, their sections, its Proposals, each opening its own page', () => {
    const group = riverside();
    const records = recordsOf({ groups: [group], coalitions: [], personal: [] });
    const name = group.state.name;
    const [document] = group.state.documents;

    expect(records.find((record) => record.kind === 'group')).toMatchObject({
      title: name,
      route: { name: 'group', groupId: 'riverside' },
    });
    expect(records.find((record) => record.kind === 'document')).toMatchObject({
      title: document?.title,
      from: name,
      route: { name: 'document', groupId: 'riverside', documentId: document?.id },
    });
    const [atom] = group.state.atoms;
    expect(records.find((record) => record.kind === 'section')).toMatchObject({
      title: document?.title,
      text: atom?.text,
      from: name,
      section: atom?.id,
      route: { name: 'document', groupId: 'riverside', documentId: atom?.documentId },
    });
    expect(records.find((record) => record.kind === 'proposal')).toMatchObject({
      title: 'Later quiet hours',
      text: 'Weekends run late.',
      from: name,
      route: { name: 'proposal', groupId: 'riverside', proposalId: group.proposal },
    });
  });

  it('never reads a ballot’s note, or a person’s name', () => {
    const records = recordsOf({ groups: [riverside()], coalitions: [], personal: [] });

    expect(search(records, NOTE)).toEqual([]);
    expect(search(records, 'Ben')).toEqual([]);
    for (const record of records) expect(`${record.title} ${record.text}`).not.toContain(NOTE);
  });

  it('reads only the Documents of an archived group', () => {
    const group = { ...riverside(), archived: true };
    const kinds = new Set(
      recordsOf({ groups: [group], coalitions: [], personal: [] }).map((r) => r.kind),
    );

    expect([...kinds].filter((kind) => kind !== 'place').sort()).toEqual(['document', 'section']);
  });

  it('reads a coalition by name, and its Documents, each opening its coalition page', () => {
    const { state } = testGroup({ name: 'Eastside Housing', title: 'Our statement' });
    const records = recordsOf({
      groups: [],
      coalitions: [{ coalitionId: 'eastside', state }],
      personal: [],
    });

    expect(records.find((record) => record.kind === 'coalition')).toMatchObject({
      title: 'Eastside Housing',
      route: { name: 'coalition', coalitionId: 'eastside' },
    });
    expect(records.find((record) => record.kind === 'section')).toMatchObject({
      from: 'Eastside Housing',
      route: { name: 'coalitionDocument', coalitionId: 'eastside' },
    });
  });

  it('reads personal Documents, and the app’s own places', () => {
    const records = recordsOf({
      groups: [],
      coalitions: [],
      personal: [{ id: 'me-1', title: 'Résumé', text: 'What I have done.', updatedAt: 9 }],
    });

    expect(records.find((record) => record.kind === 'personal')).toMatchObject({
      title: 'Résumé',
      text: 'What I have done.',
      at: 9,
      route: { name: 'personalDocument', id: 'me-1' },
    });
    const places = records
      .filter((record) => record.kind === 'place')
      .map((record) => record.title);
    expect(places).toEqual(
      expect.arrayContaining([
        'Your groups',
        'Discover',
        'Personal',
        'Settings',
        'Recovery contacts',
      ]),
    );
    expect(search(records, 'settings').map((result) => result.record.route)).toEqual([
      { name: 'settings' },
    ]);
  });

  it('gives every record its own id', () => {
    const records = recordsOf({ groups: [riverside()], coalitions: [], personal: [] });

    expect(new Set(records.map((record) => record.id)).size).toBe(records.length);
  });
});
