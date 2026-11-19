import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildVersion } from './buildVersion';

describe('buildVersion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is the version the build wrote in, the one its service worker caches under', () => {
    vi.stubGlobal('__RECONCILE_BUILD_VERSION__', '0123456789abcdef');
    expect(buildVersion()).toBe('0123456789abcdef');
  });

  it('is null where no build wrote one, as in development and tests', () => {
    expect(buildVersion()).toBeNull();
  });
});
