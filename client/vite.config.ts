/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // The app calls the relay at /v1 on its own origin. In development, and in
  // `vite preview` (which reuses server.proxy), that is ./scripts/relay.sh.
  const { RECONCILE_RELAY_PORT = '8787' } = loadEnv(mode, '.', 'RECONCILE_RELAY_');

  return {
    plugins: [react()],
    server: {
      proxy: { '/v1': `http://127.0.0.1:${RECONCILE_RELAY_PORT}` },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/test/**',
          'src/main.tsx',
          'src/test-setup.ts',
          'src/vite-env.d.ts',
        ],
        thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
      },
    },
  };
});
