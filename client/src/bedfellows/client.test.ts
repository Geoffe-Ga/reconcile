/**
 * The page's side of the Bedfellows worker (#475): it sends a run, hands back
 * its rows, and can cancel it. jsdom has no Worker, so a fake stands in: it
 * records what the page posts, and the test answers as the worker would.
 */
import { describe, expect, it } from 'vitest';

import { type BedfellowsWorker, createBedfellowsClient } from './client';
import type { BedfellowsInput, FromWorker, Row, ToWorker } from './types';

const INPUT: BedfellowsInput = {
  reader: [{ title: 'Ours', text: 'Keep the library open on Sundays.' }],
  entries: [{ id: 'e1', title: '', text: 'We want the library open.' }],
  dial: 0,
};

const ROW: Row = {
  entryId: 'e1',
  tier: 'middle',
  reason: {
    entrySentence: 'We want the library open.',
    readerSentence: 'Keep it.',
    verified: false,
  },
};

/** A fake worker: what the page posted, and a way to answer as the worker. */
function fakeWorker(): BedfellowsWorker & {
  readonly sent: ToWorker[];
  answer(message: FromWorker): void;
  fail(): void;
  terminated: boolean;
} {
  const fake = {
    sent: [] as ToWorker[],
    terminated: false,
    onmessage: null as BedfellowsWorker['onmessage'],
    onerror: null as BedfellowsWorker['onerror'],
    postMessage(message: ToWorker) {
      fake.sent.push(message);
    },
    terminate() {
      fake.terminated = true;
    },
    answer(message: FromWorker) {
      fake.onmessage?.(new MessageEvent('message', { data: message }));
    },
    fail() {
      fake.onerror?.(new ErrorEvent('error'));
    },
  };
  return fake;
}

describe('createBedfellowsClient (#475)', () => {
  it('starts no worker until the first run, then sends it the input and resolves with its rows', async () => {
    const worker = fakeWorker();
    let made = 0;
    const client = createBedfellowsClient(() => {
      made += 1;
      return worker;
    });
    expect(made).toBe(0);

    const run = client.run(INPUT);
    expect(worker.sent).toEqual([{ type: 'run', id: 1, input: INPUT }]);
    worker.answer({ type: 'rows', id: 1, rows: [ROW] });

    await expect(run.rows).resolves.toEqual([ROW]);
    expect(made).toBe(1);
  });

  it('keeps one worker for every run, and gives each run its own id and its own rows', async () => {
    const worker = fakeWorker();
    let made = 0;
    const client = createBedfellowsClient(() => {
      made += 1;
      return worker;
    });

    const first = client.run(INPUT);
    const second = client.run(INPUT);
    worker.answer({ type: 'rows', id: 2, rows: [] });
    worker.answer({ type: 'rows', id: 1, rows: [ROW] });

    await expect(first.rows).resolves.toEqual([ROW]);
    await expect(second.rows).resolves.toEqual([]);
    expect(made).toBe(1);
  });

  it('rejects a run the worker says failed', async () => {
    const worker = fakeWorker();
    const run = createBedfellowsClient(() => worker).run(INPUT);

    worker.answer({ type: 'error', id: 1 });

    await expect(run.rows).rejects.toThrow('The Bedfellows run failed.');
  });

  it('cancels a run: tells the worker, rejects with an AbortError, and ignores a late answer', async () => {
    const worker = fakeWorker();
    const run = createBedfellowsClient(() => worker).run(INPUT);

    run.cancel();
    run.cancel();
    worker.answer({ type: 'rows', id: 1, rows: [ROW] });

    await expect(run.rows).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.sent).toEqual([
      { type: 'run', id: 1, input: INPUT },
      { type: 'cancel', id: 1 },
    ]);
  });

  it('doesn’t cancel a run that has already answered', async () => {
    const worker = fakeWorker();
    const run = createBedfellowsClient(() => worker).run(INPUT);

    worker.answer({ type: 'rows', id: 1, rows: [ROW] });
    run.cancel();

    await expect(run.rows).resolves.toEqual([ROW]);
    expect(worker.sent).toHaveLength(1);
  });

  it('rejects every open run when the worker itself fails, and starts a fresh worker for the next', async () => {
    const workers = [fakeWorker(), fakeWorker()];
    let made = 0;
    const client = createBedfellowsClient(() => {
      const next = workers[made];
      made += 1;
      if (next === undefined) throw new Error('Only two workers.');
      return next;
    });

    const run = client.run(INPUT);
    workers[0]?.fail();

    await expect(run.rows).rejects.toThrow('The Bedfellows run failed.');
    expect(workers[0]?.terminated).toBe(true);
    client.run(INPUT);
    expect(made).toBe(2);
    expect(workers[1]?.sent).toEqual([{ type: 'run', id: 2, input: INPUT }]);
  });

  it('fails the run, rather than throwing, when the worker can’t start', async () => {
    const client = createBedfellowsClient(() => {
      throw new DOMException('Blocked by the CSP.', 'SecurityError');
    });

    const run = client.run(INPUT);
    run.cancel();

    await expect(run.rows).rejects.toThrow('The Bedfellows run failed.');
  });

  it('closes: ends the worker and rejects every open run with an AbortError', async () => {
    const worker = fakeWorker();
    const client = createBedfellowsClient(() => worker);
    client.close();
    expect(worker.terminated).toBe(false);

    const run = client.run(INPUT);
    client.close();

    await expect(run.rows).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });
});
