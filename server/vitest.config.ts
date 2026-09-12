import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Without this, a production build leaves compiled copies of every test in
    // dist/ and vitest collects both — the suite silently doubles and the
    // stale copies keep passing after their source has changed.
    exclude: ['dist/**', 'node_modules/**'],
  },
});
