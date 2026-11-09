/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/main.tsx', 'src/test-setup.ts', 'src/vite-env.d.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
  // The CSP below allows no data: URLs, so no asset (a small font subset, say)
  // may be inlined as one: every asset is a file served from 'self'.
  build: { assetsInlineLimit: 0 },
  // deploy/Caddyfile's CSP, so the e2e loop under `vite preview` runs the build
  // under the policy members get. deploy/check.sh keeps the two equal.
  preview: {
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  },
});
