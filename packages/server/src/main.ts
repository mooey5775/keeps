import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTracker } from './analytics.ts';
import { createKeepsServer } from './server.ts';

const root = join(import.meta.dirname, '../../..');
const webDir = join(root, 'packages/web/dist');
const port = Number(process.env.PORT ?? 8787);

const server = await createKeepsServer({
  port,
  cardsDir: join(root, 'cards'),
  dataDir: process.env.KEEPS_DATA_DIR ?? join(root, 'data'),
  tracker: createTracker(process.env),
  // The PostHog project key is meant to be public (browsers send it); the browser uses it for session replay.
  publicConfig: {
    ...(process.env.POSTHOG_KEY ? { posthogKey: process.env.POSTHOG_KEY } : {}),
    ...(process.env.POSTHOG_HOST ? { posthogHost: process.env.POSTHOG_HOST } : {}),
  },
  ...(process.env.ADMIN_TOKEN ? { adminToken: process.env.ADMIN_TOKEN } : {}),
  ...(existsSync(webDir) ? { webDir } : {}),
});

console.log(`Keeps server on http://localhost:${port}${existsSync(webDir) ? '' : ' (API only; web client not built)'}`);
console.log(`Analytics: ${process.env.POSTHOG_KEY ? 'PostHog' : 'off'} · admin page: ${process.env.ADMIN_TOKEN ? '/admin' : 'off'}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
