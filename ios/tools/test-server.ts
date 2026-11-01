// The website's game server, for the app's UI tests of online play: nothing kept, Midstrike playing its network's own
// moves, quickly. ios/test.sh runs it here and forwards its port to the Mac (ssh -R), where the simulator finds it at
// ws://localhost:<port>/ws (the tests' KEEPS_SERVER).
//   node ios/tools/test-server.ts [port]     (default 7777; says "ready" once it listens)
import { join } from 'node:path';
import { createKeepsServer } from '../../packages/server/src/server.ts';

const root = join(import.meta.dirname, '../..');
const port = Number(process.argv[2] ?? 7777);
const server = await createKeepsServer({
  port,
  cardsDir: join(root, 'cards'),
  botWeights: join(root, 'packages/learn/demo/weights/midstrike.bin'),
  botName: 'Midstrike',
  botDelay: () => 300,
});
console.log(`ready on ${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void server.close().then(() => process.exit(0)));
