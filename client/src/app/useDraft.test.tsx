import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Draft, GroupDrafts } from '../store/drafts';
import { memoryDrafts } from '../test/drafts';
import { DRAFT_SAVE_DELAY_MS, useDraft } from './useDraft';

const START: Draft = { title: '', why: '', text: 'Quiet after ten.\n', link: '' };
const TYPED: Draft = { ...START, title: 'Later', why: 'Weekends.' };

async function mount(drafts: GroupDrafts, start: Draft = START) {
  const hook = renderHook(() => useDraft(drafts, 'atom-1', start));
  // Let the load settle.
  await act(async () => {
    await Promise.resolve();
  });
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDraft', () => {
  it('starts from the given values when there is no draft', async () => {
    const { drafts } = memoryDrafts();
    const { result } = await mount(drafts);
    expect(result.current.values).toEqual(START);
    expect(result.current.restored).toBe(false);
    expect(result.current.changed).toBe(false);
    expect(drafts.load).toHaveBeenCalledWith('atom-1');
  });

  it('has no values until the draft is read', () => {
    const { drafts } = memoryDrafts();
    const { result } = renderHook(() => useDraft(drafts, 'atom-1', START));
    expect(result.current.values).toBeNull();
  });

  it('brings back a saved draft and says so', async () => {
    const { drafts } = memoryDrafts({ 'atom-1': TYPED });
    const { result } = await mount(drafts);
    expect(result.current.values).toEqual(TYPED);
    expect(result.current.restored).toBe(true);
    expect(result.current.changed).toBe(true);
  });

  it('starts from the given values when the draft can’t be read', async () => {
    const { drafts } = memoryDrafts();
    drafts.load.mockRejectedValueOnce(new Error('blocked'));
    const { result } = await mount(drafts);
    expect(result.current.values).toEqual(START);
  });

  it('saves about 500 ms after typing stops, once, with the latest values', async () => {
    const { drafts, shelf } = memoryDrafts();
    const { result } = await mount(drafts);
    act(() => {
      result.current.update({ ...START, title: 'L' });
    });
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS - 1);
      result.current.update(TYPED);
    });
    act(() => {
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS - 1);
    });
    expect(drafts.save).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(drafts.save).toHaveBeenCalledTimes(1);
    expect(shelf.get('atom-1')).toEqual(TYPED);
    expect(result.current.values).toEqual(TYPED);
    expect(DRAFT_SAVE_DELAY_MS).toBe(500);
  });

  it('saves what is waiting when the composer closes', async () => {
    const { drafts, shelf } = memoryDrafts();
    const { result, unmount } = await mount(drafts);
    act(() => {
      result.current.update(TYPED);
    });
    unmount();
    expect(shelf.get('atom-1')).toEqual(TYPED);
  });

  it('counts a Dispatch added, changed or removed as a change, and the same one as none (#112)', async () => {
    const dispatch = { title: 'Updated', text: '' };
    const { drafts } = memoryDrafts();
    const { result } = await mount(drafts, { ...START, dispatch });
    expect(result.current.changed).toBe(false);
    act(() => {
      result.current.update({ ...START, dispatch: { ...dispatch, text: 'More' } });
    });
    expect(result.current.changed).toBe(true);
    act(() => {
      result.current.update({ ...START, dispatch: { ...dispatch, title: 'Other' } });
    });
    expect(result.current.changed).toBe(true);
    act(() => {
      result.current.update(START);
    });
    expect(result.current.changed).toBe(true);
    act(() => {
      result.current.update({ ...START, dispatch: { ...dispatch } });
    });
    expect(result.current.changed).toBe(false);
  });

  it('counts a move’s place chosen as a change, and saves it, first included (#103)', async () => {
    const { drafts, shelf } = memoryDrafts();
    const { result } = await mount(drafts);
    act(() => {
      result.current.update({ ...START, moveAfter: null });
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });
    expect(result.current.changed).toBe(true);
    expect(shelf.get('atom-1')).toEqual({ ...START, moveAfter: null });
    act(() => {
      result.current.update({ ...START, moveAfter: 'g.1' });
    });
    expect(result.current.changed).toBe(true);
    act(() => {
      result.current.update(START);
    });
    expect(result.current.changed).toBe(false);
  });

  it('counts a class chosen as a change, and saves it (#116)', async () => {
    const { drafts, shelf } = memoryDrafts();
    const { result } = await mount(drafts);
    act(() => {
      result.current.update({ ...START, classTo: 'eternal' });
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });
    expect(result.current.changed).toBe(true);
    expect(shelf.get('atom-1')).toEqual({ ...START, classTo: 'eternal' });
    act(() => {
      result.current.update({ ...START, classTo: 'entrenched' });
    });
    expect(result.current.changed).toBe(true);
    act(() => {
      result.current.update(START);
    });
    expect(result.current.changed).toBe(false);
  });

  it('counts a new Document’s title typed as a change, and saves it (#92)', async () => {
    const { drafts, shelf } = memoryDrafts();
    const { result } = await mount(drafts, { ...START, documentTitle: '' });
    act(() => {
      result.current.update({ ...START, documentTitle: 'Budget' });
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });
    expect(result.current.changed).toBe(true);
    expect(shelf.get('atom-1')?.documentTitle).toBe('Budget');
  });

  it('clears the draft instead when the values are back where they started', async () => {
    const { drafts, shelf } = memoryDrafts({ 'atom-1': TYPED });
    const { result } = await mount(drafts);
    act(() => {
      result.current.update(START);
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });
    expect(drafts.save).not.toHaveBeenCalled();
    expect(shelf.has('atom-1')).toBe(false);
    expect(result.current.changed).toBe(false);
  });

  it('saves nothing once held, even on close, until resumed', async () => {
    const { drafts, shelf } = memoryDrafts();
    const { result, unmount } = await mount(drafts);
    act(() => {
      result.current.update(TYPED);
      result.current.hold();
      result.current.update({ ...TYPED, title: 'After' });
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
    });
    expect(drafts.save).not.toHaveBeenCalled();
    act(() => {
      result.current.resume();
    });
    expect(shelf.get('atom-1')).toEqual({ ...TYPED, title: 'After' });
    act(() => {
      result.current.hold();
    });
    unmount();
    expect(drafts.save).toHaveBeenCalledTimes(1);
  });

  it('discards: clears the stored draft and starts over', async () => {
    const { drafts, shelf } = memoryDrafts({ 'atom-1': TYPED });
    const { result, unmount } = await mount(drafts);
    act(() => {
      result.current.update({ ...TYPED, title: 'More' });
      result.current.discard();
    });
    expect(shelf.has('atom-1')).toBe(false);
    expect(result.current.values).toEqual(START);
    expect(result.current.restored).toBe(false);
    expect(result.current.changed).toBe(false);
    unmount();
    expect(drafts.save).not.toHaveBeenCalled();
  });

  it('keeps the values it started from, though the caller’s start moves on', async () => {
    const { drafts } = memoryDrafts();
    const hook = renderHook(({ start }) => useDraft(drafts, 'atom-1', start), {
      initialProps: { start: START },
    });
    await act(async () => {
      await Promise.resolve();
    });
    hook.rerender({ start: { ...START, link: 'https://chat.example.org/new' } });
    expect(hook.result.current.values).toEqual(START);
    expect(drafts.load).toHaveBeenCalledTimes(1);
  });

  it('shrugs off a save that fails: the draft is a convenience', async () => {
    const { drafts } = memoryDrafts();
    drafts.save.mockRejectedValueOnce(new Error('quota'));
    drafts.clear.mockRejectedValueOnce(new Error('quota'));
    const { result } = await mount(drafts);
    act(() => {
      result.current.update(TYPED);
      vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS);
      result.current.discard();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.values).toEqual(START);
  });
});
