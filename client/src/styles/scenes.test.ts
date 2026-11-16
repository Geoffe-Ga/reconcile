/**
 * Painted edges (DESIGN.md, ADR-0078): which screens show the painting around
 * their edges, and which stay plain so nothing pulls at a reader's attention.
 * This reads the screens' own source, so a new screen has to take a side.
 */
import { describe, expect, it } from 'vitest';

import appCss from './app.css?raw';

const sources = import.meta.glob<string>('../screens/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The edge pieces the build ships, by path: `public/edges/`, as `painting/paint.py` cuts them. */
const pieces = Object.keys(import.meta.glob('../../public/edges/*.webp', { query: '?url' }));

/** The screens that show a scene at their edges, and which one. */
const PAINTED: Readonly<Record<string, string>> = {
  // Arriving and setting out: open sky.
  InstallGuide: 'sky',
  Start: 'sky',
  CreateGroup: 'sky',
  Join: 'sky',
  Follow: 'sky',
  FrontDoor: 'sky',
  BringCard: 'sky',
  Discover: 'sky',
  // A group, standing: its canopy, and the trunks that hold its rules.
  GroupHome: 'canopy',
  GroupStatus: 'canopy',
  Dispatches: 'canopy',
  GroupRules: 'trunks',
  // What's out of sight: what's yours alone, and the roots groups share.
  Personal: 'soil',
  CoalitionHome: 'soil',
};

/**
 * The screens that stay plain: reading a Document or its history, writing or
 * weighing a Proposal or a Dispatch, the pilot notice, anything to do with
 * keys, recovery or linking a device, and Settings. Care matters more than
 * color there.
 */
const PLAIN = [
  'ChangeLog',
  'Composer',
  'DissolveComposer',
  'DocumentView',
  'HelpRecover',
  'LinkNewDevice',
  'LinkThisDevice',
  'OptInComposer',
  'PasskeyOffer',
  'PersonalDocument',
  'PilotNotice',
  'PriorityComposer',
  'ReconcileCard',
  'RecoverStart',
  'RecoveryContacts',
  'RemovalComposer',
  'SectionComposer',
  'SendDispatch',
  'Settings',
  'SharedPage',
  'StewardComposer',
  'UnlockScreen',
];

/** Each screen file that renders the page shell, by name, with its source. */
const shells = Object.entries(sources)
  .filter(([path, source]) => !path.includes('.test.') && source.includes('className="shell"'))
  .map(([path, source]) => [path.replace(/^.*\/(\w+)\.tsx$/, '$1'), source] as const);

describe('painted edges', () => {
  it('has every screen with a page shell take a side: a scene, or plain', () => {
    const named = [...Object.keys(PAINTED), ...PLAIN].sort();
    expect(shells.map(([name]) => name).sort()).toEqual(named);
  });

  it.each(Object.entries(PAINTED))('shows %s the %s on every shell it renders', (name, scene) => {
    const source = shells.find(([screen]) => screen === name)?.[1] ?? '';
    const all = source.split('className="shell"').length - 1;
    const painted = source.split(`className="shell" data-scene="${scene}"`).length - 1;
    expect(all).toBeGreaterThan(0);
    expect(painted).toBe(all);
  });

  it.each(PLAIN)('keeps %s plain', (name) => {
    const source = shells.find(([screen]) => screen === name)?.[1] ?? '';
    expect(source).not.toContain('data-scene');
  });

  it.each([...new Set(Object.values(PAINTED))])('ships the %s edge and its rule', (scene) => {
    expect(appCss).toContain(
      `.shell[data-scene='${scene}'] {\n  --scene: url('/edges/${scene}.webp');`,
    );
    expect(pieces).toContain(`../../public/edges/${scene}.webp`);
  });

  it('draws the edge as a ring over the page that takes no presses, by day and by night', () => {
    expect(appCss).toContain('linear-gradient(#000 0 0) content-box exclude');
    expect(appCss).toContain('padding: var(--edge);\n  pointer-events: none;');
    expect(appCss).toMatch(
      /prefers-color-scheme: dark\) \{\n {2}\.shell\[data-scene\] \{\n {4}--edge-tint/,
    );
  });
});
