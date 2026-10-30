// The spike's page and its workers, bundled for the app (served from the app bundle through the keeps:// scheme).
//   packages/learn/node_modules/.bin/vite build --config ios/web/vite.config.mjs
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default {
  root: here,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: fileURLToPath(new URL('../build/web', import.meta.url)),
    emptyOutDir: true,
    target: 'safari18',
    minify: false,
    sourcemap: true,
  },
  worker: { format: 'es' },
};
