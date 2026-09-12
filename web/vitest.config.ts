import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // happy-dom rather than a real browser: these tests are about component
    // behaviour, and the plan deliberately excludes browser-level E2E
    // (ASSUMPTIONS.md #31).
    environment: 'happy-dom',
    globals: false,
    exclude: ['dist/**', 'node_modules/**'],
  },
});
