import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// index.html sets the page's language; jsdom's blank document doesn't.
document.documentElement.lang = 'en';

// Testing Library only auto-cleans when Vitest globals are on; they're off here.
afterEach(cleanup);

// The app pins the steward's real public keys (#488), which no test holds the
// secret of; every test pins the tests' own (`src/test/steward.ts`) instead.
// `shelf/steward.test.ts` reads the app's own pins through `vi.importActual`.
vi.mock('./shelf/steward', async () => {
  const { TEST_PINS } = await import('./test/steward');
  return { STEWARD_PINS: TEST_PINS };
});
