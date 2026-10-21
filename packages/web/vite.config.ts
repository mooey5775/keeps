import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the game server runs separately (pnpm --filter @keeps/server dev).
const server = process.env.KEEPS_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
});
