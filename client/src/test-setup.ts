import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// index.html sets the page's language; jsdom's blank document doesn't.
document.documentElement.lang = 'en';

// Testing Library only auto-cleans when Vitest globals are on; they're off here.
afterEach(cleanup);

// A `findBy` or `waitFor` waits for what the test is about, never times it:
// Testing Library's own 1 s fails a passing test whenever CI's runner is busy
// (a ballot's "Sent", say), so a wait gets 5 s, inside the 15 s test limit
// (`testTimeout` in vite.config.ts).
configure({ asyncUtilTimeout: 5_000 });

// The app pins the steward's real public keys (#488), which no test holds the
// secret of; every test pins the tests' own (`src/test/steward.ts`) instead.
// `shelf/steward.test.ts` reads the app's own pins through `vi.importActual`.
vi.mock('./shelf/steward', async () => {
  const { TEST_PINS } = await import('./test/steward');
  return { STEWARD_PINS: TEST_PINS };
});
