/**
 * The Bedfellows worker (#475): it takes a run, posts its rows back, and
 * stops a run it's told to cancel, keeping nothing of any run once it ends.
 * jsdom has no Worker, so these tests drive the worker's handler directly,
 * and its entry through a stand-in for the worker's global scope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standInEmbedder, standInJudge } from './standIns';
import type { BedfellowsInput, Embedder, FromWorker, Models, ToWorker } from './types';
import { createRunner, embedderFor, WORKER_EMBEDDER, yielding } from './worker';

const INPUT: BedfellowsInput = {
  reader: [{ title: 'Ours', text: 'Keep the library open on Sundays.' }],
  entries: [
    { id: 'e1', title: '', text: 'We want the library open.' },
    { id: 'e2', title: '', text: 'Feed the ducks at the pond.' },
  ],
  dial: 0,
};

const STAND_INS: Models = { embedder: standInEmbedder, judge: standInJudge };

/** An embedder that holds each call until the test lets it go. */
function gated(): { embedder: Embedder; release: () => void; calls: () => number } {
  let calls = 0;
  const waiting: (() => void)[] = [];
  return {
    embedder: {
      embed: async (sentences) => {
        calls += 1;
        await new Promise<void>((resolve) => waiting.push(resolve));
        return standInEmbedder.embed(sentences);
      },
    },
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
    calls: () => calls,
  };
}

/** Lets every queued microtask and the next macrotask run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createRunner (#475)', () => {
  it('runs the pipeline and posts its rows under the run’s id', async () => {
    const posted: FromWorker[] = [];
    const runner = createRunner(STAND_INS, (message) => posted.push(message));

    runner.handle({ type: 'run', id: 7, input: INPUT });
    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });

    expect(posted[0]).toEqual({
      type: 'rows',
      id: 7,
      rows: [
        {
          entryId: 'e1',
          tier: 'middle',
          reason: {
            entrySentence: 'We want the library open.',
            readerSentence: 'Keep the library open on Sundays.',
            verified: false,
          },
        },
      ],
    });
    expect(runner.inFlight()).toBe(0);
  });

  it('posts a bare error, with no words in it, when a model fails, and keeps nothing of the run', async () => {
    const posted: FromWorker[] = [];
    const broken: Models = {
      embedder: { embed: () => Promise.reject(new Error('Keep the library open on Sundays.')) },
      judge: standInJudge,
    };
    const runner = createRunner(broken, (message) => posted.push(message));

    runner.handle({ type: 'run', id: 3, input: INPUT });
    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });

    expect(posted).toEqual([{ type: 'error', id: 3 }]);
    expect(runner.inFlight()).toBe(0);
  });

  it('stops a cancelled run, posts nothing for it, and keeps nothing of it', async () => {
    const posted: FromWorker[] = [];
    const gate = gated();
    const runner = createRunner({ ...STAND_INS, embedder: gate.embedder }, (message) =>
      posted.push(message),
    );

    runner.handle({ type: 'run', id: 1, input: INPUT });
    expect(runner.inFlight()).toBe(1);
    runner.handle({ type: 'cancel', id: 1 });
    gate.release();
    await settle();
    gate.release();
    await settle();

    expect(gate.calls()).toBe(1);
    expect(posted).toEqual([]);
    expect(runner.inFlight()).toBe(0);
  });

  it('cancels only the run it names, and ignores a cancel for a run it doesn’t hold', async () => {
    const posted: FromWorker[] = [];
    const runner = createRunner(STAND_INS, (message) => posted.push(message));

    runner.handle({ type: 'cancel', id: 99 });
    runner.handle({ type: 'run', id: 2, input: INPUT });
    runner.handle({ type: 'cancel', id: 99 });
    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });

    expect(posted[0]).toMatchObject({ type: 'rows', id: 2 });
  });
});

describe('yielding (#475)', () => {
  it('lets other tasks run before each embedding, so a cancel can land mid-run', async () => {
    const order: string[] = [];
    const embedder = yielding({
      embed: (sentences) => {
        order.push('embed');
        return standInEmbedder.embed(sentences);
      },
    });

    setTimeout(() => order.push('task'), 0);
    const vectors = embedder.embed(['Keep it open.']);
    await vectors;

    expect(order).toEqual(['task', 'embed']);
    expect(await vectors).toEqual(await standInEmbedder.embed(['Keep it open.']));
  });
});

describe('embedderFor (#476)', () => {
  afterEach(() => {
    vi.doUnmock('./embedder');
    vi.resetModules();
  });

  it('runs the stand-in in this issue: #477 switches matching to the model', () => {
    expect(WORKER_EMBEDDER).toBe('stand-in');
  });

  it('gives the stand-in’s vectors for the stand-in, loading no model', async () => {
    const load = vi.fn();
    await expect(embedderFor('stand-in', load).embed(['Keep it open.'])).resolves.toEqual(
      await standInEmbedder.embed(['Keep it open.']),
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the model only when first asked for a vector, and only once', async () => {
    const load = vi.fn(() => Promise.resolve(standInEmbedder));
    const embedder = embedderFor('model', load);
    expect(load).not.toHaveBeenCalled();

    await embedder.embed(['Keep it open.']);
    const vectors = await embedder.embed(['Keep it open.']);

    expect(load).toHaveBeenCalledTimes(1);
    expect(vectors).toEqual(await standInEmbedder.embed(['Keep it open.']));
  });

  it('asks the model again after a load fails', async () => {
    const load = vi
      .fn<() => Promise<Embedder>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(standInEmbedder);
    const embedder = embedderFor('model', load);

    await expect(embedder.embed(['Keep it open.'])).rejects.toThrow('offline');
    await expect(embedder.embed(['Keep it open.'])).resolves.toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('imports the model’s module, embedder.ts, only on that first ask', async () => {
    const loadEmbedder = vi.fn(() => Promise.resolve(standInEmbedder));
    vi.doMock('./embedder', () => ({ loadEmbedder }));

    const embedder = embedderFor('model');
    expect(loadEmbedder).not.toHaveBeenCalled();
    await embedder.embed(['Keep it open.']);

    expect(loadEmbedder).toHaveBeenCalledTimes(1);
  });
});

describe('the worker’s entry (#475)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers each message on its scope with the stand-ins’ rows, posted back on that scope', async () => {
    const posted: unknown[] = [];
    const scope = new EventTarget();
    vi.stubGlobal(
      'self',
      Object.assign(scope, { postMessage: (message: unknown) => posted.push(message) }),
    );

    vi.resetModules();
    await import('./worker');
    const request: ToWorker = { type: 'run', id: 5, input: INPUT };
    scope.dispatchEvent(new MessageEvent('message', { data: request }));
    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });

    expect(posted[0]).toMatchObject({ type: 'rows', id: 5, rows: [{ entryId: 'e1' }] });
  });
});
