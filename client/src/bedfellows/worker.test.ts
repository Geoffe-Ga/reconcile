/**
 * The Bedfellows worker (#475, #477): it takes a run, posts its rows back,
 * and stops a run it's told to cancel, keeping nothing of any run once it
 * ends. It loads the model only for a run that asks for it, and falls back to
 * term overlap when it can't. jsdom has no Worker, so these tests drive the
 * worker's handler directly, and its entry through a stand-in for the
 * worker's global scope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryVectorStore } from './entryVectors';
import { standInEmbedder, standInJudge } from './standIns';
import type { BedfellowsInput, Embedder, FromWorker, StanceJudge, ToWorker } from './types';
import { createRunner, type WorkerSetup, yielding } from './worker';

const INPUT: BedfellowsInput = {
  reader: [{ title: 'Ours', text: 'Keep the library open on Sundays.' }],
  entries: [
    { id: 'e1', title: '', text: 'We want the library open.' },
    { id: 'e2', title: '', text: 'Feed the ducks at the pond.' },
  ],
  dial: 0,
};

/** The row the stand-in embedder gives INPUT, unverified, as the stand-in judge always is. */
const LIBRARY_ROW = {
  entryId: 'e1',
  reason: {
    entrySentence: 'We want the library open.',
    readerSentence: 'Keep the library open on Sundays.',
    verified: false,
  },
};

/** A setup whose model is the stand-in embedder, counting its loads. */
function standIn(model: Embedder = standInEmbedder): WorkerSetup & { loads: () => number } {
  let loads = 0;
  return {
    judge: standInJudge,
    loadModel: () => {
      loads += 1;
      return Promise.resolve(model);
    },
    loads: () => loads,
  };
}

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

/** Runs `request` on a runner of `setup`, and resolves with what it posted. */
async function answerTo(setup: WorkerSetup, request: ToWorker): Promise<FromWorker[]> {
  const posted: FromWorker[] = [];
  const runner = createRunner(setup, (message) => posted.push(message));
  runner.handle(request);
  await vi.waitFor(() => {
    expect(posted).toHaveLength(1);
  });
  expect(runner.inFlight()).toBe(0);
  return posted;
}

describe('createRunner (#475, #477)', () => {
  it('runs the pipeline with the model when the run asks for it, and posts its rows under the run’s id', async () => {
    const setup = standIn();

    const posted = await answerTo(setup, { type: 'run', id: 7, input: INPUT, model: true });

    expect(posted).toEqual([{ type: 'rows', id: 7, rows: [{ ...LIBRARY_ROW, tier: 'middle' }] }]);
    expect(setup.loads()).toBe(1);
  });

  it('loads no model for a run that doesn’t ask, and matches by term overlap', async () => {
    const setup = standIn();

    const posted = await answerTo(setup, { type: 'run', id: 8, input: INPUT, model: false });

    expect(posted).toEqual([{ type: 'rows', id: 8, rows: [{ ...LIBRARY_ROW, tier: 'close' }] }]);
    expect(setup.loads()).toBe(0);
  });

  it('falls back to term overlap when the model won’t load, and tries the load again on the next run', async () => {
    const loadModel = vi
      .fn<() => Promise<Embedder>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(standInEmbedder);
    const setup: WorkerSetup = { judge: standInJudge, loadModel };

    const offline = await answerTo(setup, { type: 'run', id: 1, input: INPUT, model: true });
    const online = await answerTo(setup, { type: 'run', id: 2, input: INPUT, model: true });

    expect(offline).toEqual([{ type: 'rows', id: 1, rows: [{ ...LIBRARY_ROW, tier: 'close' }] }]);
    expect(online).toEqual([{ type: 'rows', id: 2, rows: [{ ...LIBRARY_ROW, tier: 'middle' }] }]);
    expect(loadModel).toHaveBeenCalledTimes(2);
  });

  it('keeps entry vectors in its store, and only for a run with the model', async () => {
    const store = memoryVectorStore();

    await answerTo({ ...standIn(), store }, { type: 'run', id: 1, input: INPUT, model: false });
    expect(store.records()).toEqual([]);
    await answerTo({ ...standIn(), store }, { type: 'run', id: 2, input: INPUT, model: true });

    expect(store.records().map((record) => record.entryId)).toEqual(['e1', 'e2']);
  });

  it('judges with the stance model once the embedding model has loaded, and a pair it agrees with is verified (#478)', async () => {
    const agreeing: StanceJudge = { judge: () => Promise.resolve('agrees') };
    const loadJudge = vi.fn(() => Promise.resolve(agreeing));

    const posted = await answerTo(
      { ...standIn(), loadJudge },
      { type: 'run', id: 3, input: INPUT, model: true },
    );

    expect(posted).toEqual([
      {
        type: 'rows',
        id: 3,
        rows: [
          { ...LIBRARY_ROW, tier: 'middle', reason: { ...LIBRARY_ROW.reason, verified: true } },
        ],
      },
    ]);
    expect(loadJudge).toHaveBeenCalledTimes(1);
  });

  it('leaves out, saying nothing, an entry whose only pair the stance model opposes (#478)', async () => {
    const opposing: StanceJudge = { judge: () => Promise.resolve('opposes') };

    const posted = await answerTo(
      { ...standIn(), loadJudge: () => Promise.resolve(opposing) },
      { type: 'run', id: 4, input: INPUT, model: true },
    );

    expect(posted).toEqual([{ type: 'rows', id: 4, rows: [] }]);
  });

  it('keeps the stand-in judge when the stance model won’t load, and asks for none without the embedding model (#478)', async () => {
    const loadJudge = vi.fn(() => Promise.reject(new Error('offline')));
    const setup: WorkerSetup = { ...standIn(), loadJudge };

    const offline = await answerTo(setup, { type: 'run', id: 5, input: INPUT, model: true });
    const overlap = await answerTo(setup, { type: 'run', id: 6, input: INPUT, model: false });

    expect(offline).toEqual([{ type: 'rows', id: 5, rows: [{ ...LIBRARY_ROW, tier: 'middle' }] }]);
    expect(overlap).toEqual([{ type: 'rows', id: 6, rows: [{ ...LIBRARY_ROW, tier: 'close' }] }]);
    expect(loadJudge).toHaveBeenCalledTimes(1);
  });

  it('posts a bare error, with no words in it, when the model fails mid-run, and keeps nothing of the run', async () => {
    const broken: Embedder = {
      embed: () => Promise.reject(new Error('Keep the library open on Sundays.')),
    };

    const posted = await answerTo(standIn(broken), {
      type: 'run',
      id: 3,
      input: INPUT,
      model: true,
    });

    expect(posted).toEqual([{ type: 'error', id: 3 }]);
  });

  it('stops a cancelled run, posts nothing for it, and keeps nothing of it', async () => {
    const posted: FromWorker[] = [];
    const gate = gated();
    const runner = createRunner(standIn(gate.embedder), (message) => posted.push(message));

    runner.handle({ type: 'run', id: 1, input: INPUT, model: true });
    expect(runner.inFlight()).toBe(1);
    await vi.waitFor(() => {
      expect(gate.calls()).toBe(1);
    });
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
    const runner = createRunner(standIn(), (message) => posted.push(message));

    runner.handle({ type: 'cancel', id: 99 });
    runner.handle({ type: 'run', id: 2, input: INPUT, model: false });
    runner.handle({ type: 'cancel', id: 99 });
    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });

    expect(posted[0]).toMatchObject({ type: 'rows', id: 2 });
  });
});

describe('yielding (#475)', () => {
  it('lets other tasks run before each embedding, so a cancel can land mid-run, and keeps the model’s name', async () => {
    const order: string[] = [];
    const embedder = yielding({
      model: 'm',
      embed: (sentences) => {
        order.push('embed');
        return standInEmbedder.embed(sentences);
      },
    });

    setTimeout(() => order.push('task'), 0);
    const vectors = embedder.embed(['Keep it open.']);
    await vectors;

    expect(order).toEqual(['task', 'embed']);
    expect(embedder.model).toBe('m');
    expect(await vectors).toEqual(await standInEmbedder.embed(['Keep it open.']));
    expect(yielding({ embed: (sentences) => standInEmbedder.embed(sentences) })).not.toHaveProperty(
      'model',
    );
  });
});

describe('the worker’s entry (#475, #477)', () => {
  afterEach(() => {
    vi.doUnmock('./embedder');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Imports the worker's entry with `self` stood in for, and returns how to send it a message. */
  async function entry(): Promise<{ send: (request: ToWorker) => void; posted: unknown[] }> {
    const posted: unknown[] = [];
    const scope = new EventTarget();
    vi.stubGlobal(
      'self',
      Object.assign(scope, { postMessage: (message: unknown) => posted.push(message) }),
    );
    vi.resetModules();
    await import('./worker');
    return {
      send: (request) => scope.dispatchEvent(new MessageEvent('message', { data: request })),
      posted,
    };
  }

  it('answers a run without the model by term overlap, importing no model', async () => {
    const loadEmbedder = vi.fn(() => Promise.resolve(standInEmbedder));
    vi.doMock('./embedder', () => ({ loadEmbedder }));
    const { send, posted } = await entry();

    send({ type: 'run', id: 5, input: INPUT, model: false });
    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });

    expect(posted[0]).toMatchObject({ type: 'rows', id: 5, rows: [{ entryId: 'e1' }] });
    expect(loadEmbedder).not.toHaveBeenCalled();
  });

  it('judges with judge.ts’s judge on a run with the model: switched off, the stand-in, so every reason is unverified (#478)', async () => {
    vi.doMock('./embedder', () => ({ loadEmbedder: () => Promise.resolve(standInEmbedder) }));
    const { send, posted } = await entry();

    send({ type: 'run', id: 9, input: INPUT, model: true });
    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });

    expect(posted[0]).toMatchObject({
      type: 'rows',
      id: 9,
      rows: [{ entryId: 'e1', reason: { verified: false } }],
    });
  });

  it('imports the model’s module, embedder.ts, on the first run with the model', async () => {
    const loadEmbedder = vi.fn(() => Promise.resolve(standInEmbedder));
    vi.doMock('./embedder', () => ({ loadEmbedder }));
    const { send, posted } = await entry();

    send({ type: 'run', id: 6, input: INPUT, model: true });
    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });

    expect(loadEmbedder).toHaveBeenCalledTimes(1);
    expect(posted[0]).toMatchObject({
      type: 'rows',
      id: 6,
      rows: [{ entryId: 'e1', tier: 'middle' }],
    });
  });
});
