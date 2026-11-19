/**
 * The build's version (#513): the service worker's plugin writes the
 * precache version into the page's chunks too, so Settings names the build
 * the worker keeps.
 */
import { describe, expect, it } from 'vitest';

import { stampVersion, VERSION_PLACEHOLDER } from './buildVersion.ts';

describe('stampVersion', () => {
  it('names the global the page reads', () => {
    expect(VERSION_PLACEHOLDER).toBe('__RECONCILE_BUILD_VERSION__');
  });

  it('writes the version in as a string wherever the code names the placeholder', () => {
    const code = `const a=typeof ${VERSION_PLACEHOLDER}=="string"?${VERSION_PLACEHOLDER}:null;`;
    expect(stampVersion(code, '0123456789abcdef')).toBe(
      'const a=typeof "0123456789abcdef"=="string"?"0123456789abcdef":null;',
    );
  });

  it('leaves code that never names it as it was', () => {
    expect(stampVersion('console.log(1);', '0123456789abcdef')).toBe('console.log(1);');
  });
});
