import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createKeepsServer } from './server.ts';

const root = join(import.meta.dirname, '../../..');
const webDir = join(root, 'packages/web/dist');
const port = Number(process.env.PORT ?? 8787);

const server = await createKeepsServer({
  port,
  cardsDir: join(root, 'cards'),
  dataDir: process.env.KEEPS_DATA_DIR ?? join(root, 'data'),
  ...(existsSync(webDir) ? { webDir } : {}),
});

console.log(`Keeps server on http://localhost:${port}${existsSync(webDir) ? '' : ' (API only; web client not built)'}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
