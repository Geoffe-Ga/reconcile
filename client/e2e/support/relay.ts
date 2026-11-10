/**
 * The real relay, started for each test exactly as `scripts/relay.sh` starts
 * it, with no test-only route, mode or flag.
 *
 * Playwright's `webServer` can't be stopped while tests run, and the
 * relay-learns-nothing spec (#71) must stop the relay before it scans what
 * the relay left on disk. So each test starts its own: on the port, SQLite
 * file and log file that `scripts/e2e.sh` chose (`RECONCILE_RELAY_PORT`,
 * `RECONCILE_RELAY_DB`, `E2E_RELAY_LOG`), stopped with SIGTERM, the way
 * systemd stops it, when the test is done. Every test shares the one
 * database, so a later scan reads every earlier test's blobs too.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { APIRequestContext } from '@playwright/test';

/** `scripts/relay.sh` at the repository's root. */
const RELAY_SH = fileURLToPath(new URL('../../../scripts/relay.sh', import.meta.url));

/** How long the relay may take to answer its health check. */
const START_MS = 30_000;
/** How long it may take to shut down after SIGTERM before it is killed. */
const STOP_MS = 10_000;
/** The wait between health checks. */
const POLL_MS = 100;

/** Where the relay keeps its data and writes its output, as `scripts/e2e.sh` set them. */
export interface RelayFiles {
  /** The SQLite file. Its `-wal` and `-shm` files sit beside it while it runs. */
  readonly db: string;
  /** The file that gets the relay's stdout and stderr. */
  readonly log: string;
}

/** A relay this test started. */
export interface RunningRelay extends RelayFiles {
  /** Stop it with SIGTERM and wait until it has exited; calling it again does nothing. */
  stop(): Promise<void>;
}

/** A variable `scripts/e2e.sh` sets, or a clear stop when it's missing. */
export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Run the e2e tests with client/scripts/e2e.sh.`);
  }
  return value;
}

/** The relay's files for this run. */
export function relayFiles(): RelayFiles {
  return { db: required('RECONCILE_RELAY_DB'), log: required('E2E_RELAY_LOG') };
}

/** The end of the relay's log, for an error message. The relay logs no requests. */
function logTail(log: string): string {
  return existsSync(log) ? readFileSync(log, 'utf8').slice(-2000) : '(no log)';
}

/** A started relay process: whether it is down, and a promise that settles once it is. */
interface RelayProcess {
  readonly child: ChildProcess;
  /** Settles once the process exits, or fails to start. */
  readonly ended: Promise<void>;
  /** Why it didn't start, or null. */
  readonly failure: () => Error | null;
}

/** Runs `scripts/relay.sh`, sending its stdout and stderr to `log`. */
function spawnRelay(log: string): RelayProcess {
  const output = openSync(log, 'a');
  let child: ChildProcess;
  try {
    child = spawn(RELAY_SH, [], { stdio: ['ignore', output, output] });
  } finally {
    closeSync(output);
  }
  let failed: Error | null = null;
  const ended = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.once('error', (error) => {
      failed = error;
      resolve();
    });
  });
  return { child, ended, failure: () => failed };
}

/** Whether the relay has exited or never started. */
function isDown({ child, failure }: RelayProcess): boolean {
  return failure() !== null || child.exitCode !== null || child.signalCode !== null;
}

/** Polls the relay's health route until it answers 200, or fails once it's down or time runs out. */
async function waitUntilHealthy(
  request: APIRequestContext,
  relay: RelayProcess,
  log: string,
): Promise<void> {
  const url = `http://127.0.0.1:${required('RECONCILE_RELAY_PORT')}/v1/health`;
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    if (isDown(relay)) {
      const why = relay.failure()?.message ?? 'it exited';
      throw new Error(
        `The relay stopped before it was ready (${why}). Its log ends:\n${logTail(log)}`,
      );
    }
    const ok = await request
      .get(url, { timeout: 1_000, failOnStatusCode: false })
      .then((response) => response.ok())
      .catch(() => false);
    if (ok) return;
    await sleep(POLL_MS);
  }
  throw new Error(
    `The relay didn't answer within ${String(START_MS)} ms. Its log ends:\n${logTail(log)}`,
  );
}

/** Sends SIGTERM and waits for the exit, killing the relay if it takes over {@link STOP_MS}. */
async function shutDown(relay: RelayProcess): Promise<void> {
  if (isDown(relay)) return;
  relay.child.kill('SIGTERM');
  const kill = setTimeout(() => relay.child.kill('SIGKILL'), STOP_MS);
  try {
    await relay.ended;
  } finally {
    clearTimeout(kill);
  }
}

/** Starts the relay with `scripts/relay.sh`, appending its output to the run's log file. */
export async function startRelay(request: APIRequestContext): Promise<RunningRelay> {
  const files = relayFiles();
  const relay = spawnRelay(files.log);
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => (stopping ??= shutDown(relay));
  try {
    await waitUntilHealthy(request, relay, files.log);
  } catch (error) {
    await stop();
    throw error;
  }
  return { ...files, stop };
}
