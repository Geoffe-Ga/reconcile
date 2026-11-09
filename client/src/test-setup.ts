import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// index.html sets the page's language; jsdom's blank document doesn't.
document.documentElement.lang = 'en';

// Testing Library only auto-cleans when Vitest globals are on; they're off here.
afterEach(cleanup);
