/**
 * The test-only page e2e/bedfellows-worker.spec.ts opens (#475): it starts the
 * Bedfellows client, which starts the worker, and hands the client to the
 * spec on `window`. No screen runs Bedfellows yet (#433 wires the view), so
 * this page stands in for that screen. It ships nothing: only the spec builds it.
 */
import { createBedfellowsClient } from '../../src/bedfellows/client';

Reflect.set(window, 'bedfellowsClient', createBedfellowsClient());
