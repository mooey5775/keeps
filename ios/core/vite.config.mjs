// The app's core (main.ts) and its search workers, bundled for the app (served from the app bundle through the
// keeps:// scheme).
//   packages/learn/node_modules/.bin/vite build --config ios/core/vite.config.mjs
import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  logLevel: 'warn',
  build: {
    outDir: fileURLToPath(new URL('../build/core', import.meta.url)),
    emptyOutDir: true,
    target: 'safari18',
    minify: false,
    sourcemap: true,
  },
  worker: { format: 'es' },
};
