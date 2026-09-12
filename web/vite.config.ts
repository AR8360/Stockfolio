import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-only. In production the API and the built frontend are one process
    // on one origin (ASSUMPTIONS.md #17), so there is no proxy and no CORS.
    // Keeping the same-origin `/api` path in both means the API client never
    // needs a base URL that differs between environments.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
