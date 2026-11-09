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
        'engine/, crypto/, and store/ are plain TypeScript so they outlive any UI framework and can be tested against protocol vectors.',
      severity: 'error',
      from: { path: '^src/(engine|crypto|store)/' },
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
        'The only network calls are to the relay and push service (client rule). Keep them in src/net/ so they can be audited in one place.',
      severity: 'error',
      from: { pathNot: ['^src/net/', '\\.test\\.tsx?$'] },
      to: { path: 'node_modules/(axios|ky|ofetch|socket\\.io-client)/' },
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
