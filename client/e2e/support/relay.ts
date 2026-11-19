/**
 * The real relay, started for each test exactly as `scripts/relay.sh` starts
 * it, with no test-only route, mode or flag.
 *
 * Playwright's `webServer` can't be stopped while tests run, and the
 * relay-learns-nothing spec (#71) must stop the relay before it scans what
 * the relay left on disk. So each test starts its own: on its worker's port,
 * SQLite file and log file, which `scripts/e2e.sh` chose (`E2E_RELAY_PORTS`,
 * `E2E_RELAY_DIR`), stopped with SIGTERM, the way systemd stops it, when the
 * test is done. Every test on a worker shares that worker's database, so a
 * later scan reads every blob the worker's earlier tests left too. No worker
 * reaches another's relay, database or log.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

/** Where a relay keeps its data and writes its output. */
export interface RelayFiles {
  /** The SQLite file. Its `-wal` and `-shm` files sit beside it while it runs. */
  readonly db: string;
  /** The file that gets the relay's stdout and stderr. */
  readonly log: string;
}

/** One worker's relay: the port it listens on, and its files. */
export interface RelaySlot extends RelayFiles {
  readonly port: string;
}

/** One Playwright worker's servers: its own `vite preview` and its own relay. */
export interface WorkerServers {
  /** The port its `vite preview` listens on, which proxies /v1 to its relay. */
  readonly web: string;
  readonly relay: RelaySlot;
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

/** The space-separated ports in `name`, one per worker, as `scripts/e2e.sh` set them. */
function ports(name: string): string[] {
  return required(name)
    .split(' ')
    .filter((port) => port !== '');
}

/**
 * Every worker's servers, in worker order: `scripts/e2e.sh` chose a web port
 * and a relay port for each, and one directory for every relay's files.
 */
export function workerServers(): WorkerServers[] {
  const web = ports('E2E_WEB_PORTS');
  const relay = ports('E2E_RELAY_PORTS');
  const dir = required('E2E_RELAY_DIR');
  return web.map((port, index) => {
    const relayPort = relay[index];
    if (relayPort === undefined || relay.length !== web.length) {
      throw new Error('E2E_WEB_PORTS and E2E_RELAY_PORTS must name one port for each worker.');
    }
    const files = join(dir, `relay-${String(index)}`);
    return { web: port, relay: { port: relayPort, db: `${files}.db`, log: `${files}.log` } };
  });
}

/** The servers of the worker Playwright numbers `parallelIndex`. */
export function serversOf(servers: readonly WorkerServers[], parallelIndex: number): WorkerServers {
  const own = servers[parallelIndex];
  if (own === undefined) {
    throw new Error(
      `No servers for worker ${String(parallelIndex)}: scripts/e2e.sh started ` +
        `${String(servers.length)}. Set E2E_WORKERS rather than passing --workers.`,
    );
  }
  return own;
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

/** Runs `scripts/relay.sh` on the slot's port and database, sending its stdout and stderr to its log. */
function spawnRelay(slot: RelaySlot): RelayProcess {
  const output = openSync(slot.log, 'a');
  let child: ChildProcess;
  try {
    child = spawn(RELAY_SH, [], {
      stdio: ['ignore', output, output],
      env: { ...process.env, RECONCILE_RELAY_PORT: slot.port, RECONCILE_RELAY_DB: slot.db },
    });
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
  { port, log }: RelaySlot,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/v1/health`;
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

/** Starts a worker's relay with `scripts/relay.sh`, appending its output to the worker's log file. */
export async function startRelay(
  request: APIRequestContext,
  slot: RelaySlot,
): Promise<RunningRelay> {
  const relay = spawnRelay(slot);
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => (stopping ??= shutDown(relay));
  try {
    await waitUntilHealthy(request, relay, slot);
  } catch (error) {
    await stop();
    throw error;
  }
  return { db: slot.db, log: slot.log, stop };
}

/**
 * Empties the relay's public shelf (#434), as a fresh relay's would be.
 *
 * Every test on a worker shares its relay's database. That costs a mailbox
 * spec nothing, since each test's mailboxes are its own, but the shelf is one
 * list that every reader reads whole: a shelf spec running after another on
 * the same worker (the other browser's run of itself, say) would find that
 * run's listings, entries and tombstones beside its own. A spec about the
 * shelf calls this first, with the relay running, as the invite-history spec
 * edits the same file (#73). It removes rows only, as a purge does.
 */
export function emptyShelf(db: string): void {
  const sqlite = new DatabaseSync(db, { timeout: 10_000 });
  try {
    sqlite.exec('DELETE FROM shelf');
  } finally {
    sqlite.close();
  }
}
