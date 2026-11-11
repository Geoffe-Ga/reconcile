/** Module boundaries for the Reconcile client (ADR-0022). */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-stays-framework-free',
      comment:
        'engine/, crypto/, store/, invite/, link/ and share/ are plain TypeScript so they outlive any UI framework and can be tested against protocol vectors.',
      severity: 'error',
      from: { path: '^src/(engine|crypto|store|invite|link|share)/' },
      to: { path: ['^src/(app|ui|screens)/', 'node_modules/(react|react-dom|react-aria-components)/'] },
    },
    {
      name: 'engine-does-no-io',
      comment:
        'The engine is pure: it folds the records sync hands it and never reaches the network itself (spec §2, #63).',
      severity: 'error',
      from: { path: '^src/engine/' },
      to: { path: '^src/net/' },
    },
    {
      name: 'only-the-net-module-talks-to-the-network',
      comment:
        'The only network calls are to the relay and, for a group that turned its chat bot on, its Discord webhook (client rule, #119). Keep them in src/net/ so they can be audited in one place.',
      severity: 'error',
      from: { pathNot: ['^src/net/', '\\.test\\.tsx?$'] },
      to: { path: 'node_modules/(axios|ky|ofetch|socket\\.io-client)/' },
    },
    {
      name: 'only-crypto-imports-noble',
      comment:
        'Every Ed25519 and hash call goes through src/crypto, so the cryptography can be audited in one place (spec §2, #69). Tests outside src/crypto use it through src/crypto too.',
      severity: 'error',
      from: { pathNot: '^src/crypto/' },
      to: { path: 'node_modules/@noble/' },
    },
    {
      name: 'crypto-imports-only-noble',
      comment:
        'src/crypto depends on no third-party package but the audited @noble/* libraries, and the one audited Shamir library that only shares.ts may import (below): no hand-rolled or unaudited cryptography (spec §2-§3, #69, ADR-0075 §4). Its tests may use the test runner.',
      severity: 'error',
      from: { path: '^src/crypto/', pathNot: '\\.test\\.tsx?$' },
      to: { dependencyTypesNot: ['local'], pathNot: 'node_modules/(@noble|shamir-secret-sharing)/' },
    },
    {
      name: 'only-shares-ts-imports-shamir',
      comment:
        'shamir-secret-sharing, pinned exactly, is the one library beyond @noble/* (ADR-0075 §4). Only src/crypto/shares.ts imports it, tests included, so recovery shares are split and rebuilt in one place (#109).',
      severity: 'error',
      from: { pathNot: '^src/crypto/shares\\.ts$' },
      to: { path: 'node_modules/shamir-secret-sharing/' },
    },
    {
      name: 'only-qr-ts-imports-qr',
      comment:
        'The QR encoder and decoder (#96) are reached only through src/app/qr.ts, so the one library outside @noble that touches a linking code can be audited in one place. Tests may decode with it directly.',
      severity: 'error',
      from: { pathNot: ['^src/app/qr\\.ts$', '\\.test\\.tsx?$'] },
      to: { path: 'node_modules/qr/' },
    },
    {
      name: 'test-helpers-stay-in-tests',
      comment:
        'src/test/ holds fakes (an in-memory relay, fake IndexedDB). Only tests may import them, so the app can never talk to a fake.',
      severity: 'error',
      from: { pathNot: ['\\.test\\.tsx?$', '^src/test/'] },
      to: { path: ['^src/test/', 'node_modules/fake-indexeddb/'] },
    },
    {
      name: 'no-test-imports-in-prod',
      severity: 'error',
      from: { pathNot: '\\.test\\.tsx?$|test-setup\\.ts$' },
      to: { path: '\\.test\\.tsx?$|node_modules/@testing-library/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.app.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
