import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the game server runs separately (pnpm --filter @keeps/server dev).
const server = process.env.KEEPS_SERVER ?? 'http://localhost:8787';

// Each production build gets an id, baked into the page and written to
// dist/build-id.txt. The server reads that file and tells browsers which build
// it serves when they connect, so a page left open across a deploy reloads
// instead of running old code (and an old copy of the engine) against it.
const buildId = process.env.KEEPS_BUILD_ID ?? `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

export default defineConfig(({ command }) => ({
  define: { __KEEPS_BUILD__: JSON.stringify(command === 'build' ? buildId : 'dev') },
  plugins: [
    react(),
    {
      name: 'keeps-build-id',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'build-id.txt', source: buildId });
      },
    },
  ],
  server: {
    proxy: {
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
}));
