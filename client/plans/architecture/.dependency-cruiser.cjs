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
        'engine/, crypto/, store/, invite/, link/, share/, door/, coalition/ and recovery/ are plain TypeScript so they outlive any UI framework and can be tested against protocol vectors.',
      severity: 'error',
      from: { path: '^src/(engine|crypto|store|invite|link|share|door|coalition|recovery)/' },
      to: { path: ['^src/(app|ui|screens)/', 'node_modules/(react|react-dom|react-aria-components)/'] },
    },
    {
      name: 'shelf-stays-framework-free',
      comment:
        'src/shelf (#484) folds the public shelf the same way on every device, so it stays plain TypeScript, tested against vectors, with no React or UI code.',
      severity: 'error',
      from: { path: '^src/shelf/' },
      to: { path: ['^src/(app|ui|screens)/', 'node_modules/(react|react-dom|react-aria-components)/'] },
    },
    {
      name: 'bedfellows-stands-alone',
      comment:
        "Bedfellows (#475, ADR-0080) reads only the text it's handed and runs in a worker of its own: no React or UI code, nothing from src/net, so it can't send the reader's writing anywhere, and nothing from src/store, so it can't keep a score or a vector (ADR-0080 §5).",
      severity: 'error',
      from: { path: '^src/bedfellows/' },
      to: {
        path: [
          '^src/(app|ui|screens|net|store)/',
          'node_modules/(react|react-dom|react-aria-components)/',
        ],
        pathNot: '^src/net/model(Files|Pins)\\.ts$',
      },
    },
    {
      name: 'corpus-stays-out-of-the-app',
      comment:
        "The labelled corpus (#474, ADR-0080 §8) and the harness that scores matchers against it are for tests and tuning runs, never the app: no other module but a test imports them, except by type, so the bundle every device downloads holds none of the corpus's invented groups and texts. corpus.ts is the only door to corpus/*.json, and harness.ts the only other module that reads corpus.ts.",
      severity: 'error',
      from: { pathNot: ['\\.test\\.tsx?$', '^src/bedfellows/(corpus|harness)\\.ts$'] },
      to: {
        path: ['^src/bedfellows/corpus(\\.ts$|/)', '^src/bedfellows/harness\\.ts$'],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'only-the-model-loaders-fetch-the-model',
      comment:
        "The one door from Bedfellows to the network is src/net/modelFiles.ts, which fetches only a pinned model file by name from our own origin and checks its hash (#476, ADR-0080 §2): no word, vector, score or stance of the reader's can ride on it. Only the two model loaders, src/bedfellows/embedder.ts and src/bedfellows/judge.ts (#478), and their tests, may use it.",
      severity: 'error',
      from: {
        path: '^src/bedfellows/',
        pathNot: '^src/bedfellows/(embedder|judge)(\\.test)?\\.ts$',
      },
      to: { path: '^src/net/' },
    },
    {
      name: 'only-runtime-ts-imports-the-runtime',
      comment:
        "ONNX Runtime Web and Hugging Face's tokenizer, pinned exactly, are the app's first machine-learning dependency (#476, ADR-0080). Only src/bedfellows/runtime.ts imports them, tests included, so the runtime can be audited and swapped in one place.",
      severity: 'error',
      from: { pathNot: '^src/bedfellows/runtime\\.ts$' },
      to: { path: 'node_modules/(onnxruntime-web|onnxruntime-common|@huggingface/tokenizers)/' },
    },
    {
      name: 'only-the-steward-console-reaches-the-classifier',
      comment:
        "The shelf classifier (#493, ADR-0082) runs only in the steward's console, on a device that holds the steward's key, and only over public shelf entries: never on a reader's device, an author's draft or a group's sealed content (ADR-0020). Only the console's app module, src/app/steward.ts, and the classifier's own test may import src/shelf/classify.ts. Other modules may name its types, which load no code.",
      severity: 'error',
      from: { pathNot: '^src/(app/steward|shelf/classify\\.test)\\.ts$' },
      to: { path: '^src/shelf/classify\\.ts$', dependencyTypesNot: ['type-only'] },
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
        'src/test/ holds fakes (an in-memory relay, fake IndexedDB). Only tests, and the setup Vitest runs before them (which pins the tests’ steward key, #488), may import them, so the app can never talk to a fake.',
      severity: 'error',
      from: { pathNot: ['\\.test\\.tsx?$', '^src/test/', '^src/test-setup\\.ts$'] },
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
