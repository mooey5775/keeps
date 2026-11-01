// The website: its game server, with Midstrike to play against (midstrike.ts), from this one entry point.
//   node packages/server/src/main.ts
// Production's settings are the defaults. The environment:
//   PORT (8787), KEEPS_DATA_DIR (./data: replays, the session log, admin-token);
//   ADMIN_TOKEN (or data/admin-token): the admin pages, /admin and /admin/bot/; without it, there are none;
//   POSTHOG_KEY, POSTHOG_HOST: analytics (off without them);
//   SITE_URL, REDIRECT_HOSTS (names, by commas): pages asked for at those names are sent to the site's address;
//   Midstrike's (midstrike.ts): BOT_WEIGHTS, BOT_NAME, REMOTE_TOKEN (its search on a remote machine), REMOTE_WORLDS,
//   MEDIUM_WORLDS, LOCAL_WORLDS, LOCAL_SEARCH=off (nothing searched here), REVIEWS=off.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTracker } from './analytics.ts';
import { midstrike, midstrikeConfig } from './midstrike.ts';
import type { Room } from './room.ts';
import { createKeepsServer } from './server.ts';

const root = join(import.meta.dirname, '../../..');
const webDir = join(root, 'packages/web/dist');
const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.KEEPS_DATA_DIR ?? join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const tokenFile = join(dataDir, 'admin-token');
const adminToken = process.env.ADMIN_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '') || undefined;

let rooms: ReadonlyMap<string, Room> = new Map();
const { describe, ...bot } = midstrike(midstrikeConfig(process.env, root), { dataDir, adminToken, rooms: () => rooms });

const server = await createKeepsServer({
  port,
  cardsDir: join(root, 'cards'),
  dataDir,
  tracker: createTracker(process.env),
  // The PostHog project key is meant to be public (browsers send it); the browser uses it for session replay.
  publicConfig: {
    ...(process.env.POSTHOG_KEY ? { posthogKey: process.env.POSTHOG_KEY } : {}),
    ...(process.env.POSTHOG_HOST ? { posthogHost: process.env.POSTHOG_HOST } : {}),
  },
  ...(adminToken ? { adminToken } : {}),
  ...(existsSync(webDir) ? { webDir } : {}),
  ...(process.env.SITE_URL ? { siteUrl: process.env.SITE_URL } : {}),
  ...(process.env.REDIRECT_HOSTS ? { redirectHosts: process.env.REDIRECT_HOSTS.split(',').map((h) => h.trim()).filter(Boolean) } : {}),
  ...bot,
});
rooms = server.rooms;

console.log(`Keeps server on http://localhost:${port}${existsSync(webDir) ? '' : ' (API only; web client not built)'}`);
console.log(`Analytics: ${process.env.POSTHOG_KEY ? 'PostHog' : 'off'} · admin pages: ${adminToken ? '/admin, /admin/bot/' : 'off'}`);
console.log(describe);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
