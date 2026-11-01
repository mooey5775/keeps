// The website's game server, for the app's UI tests of online play: nothing kept, Midstrike playing its network's own
// moves, quickly. ios/test.sh runs it here and forwards its port to the Mac (ssh -R), where the simulator finds it at
// ws://localhost:<port>/ws (the tests' KEEPS_SERVER).
//   node ios/tools/test-server.ts [port]     (default 7777; says "ready" once it listens)
// For games of three and four (a UI test drives one app): GET /test/fill?code=ABCD&players=2 seats that many players
// in the room, who play a legal move whenever it's theirs to make.
import { join } from 'node:path';
import type { ServerMessage } from '../../packages/protocol/src/index.ts';
import { createKeepsServer } from '../../packages/server/src/server.ts';

/** A player in room `code`, by WebSocket, as a browser would be: any legal move, when one is theirs to make. */
function seatPlayer(port: number, code: string, name: string): void {
  const socket = new WebSocket(`ws://localhost:${port}/ws`);
  socket.onopen = () => socket.send(JSON.stringify({ t: 'join', code, name }));
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    if (message.t !== 'game') return;
    const { view } = message;
    const legal = view.legal.filter((c) => c.type !== 'reveal-duplicity');
    if (!legal.length || !(view.prompts.some((p) => p.mine) || legal.some((c) => c.type === 'next-round'))) return;
    const command = legal[Math.floor(Math.random() * legal.length)];
    setTimeout(() => socket.send(JSON.stringify({ t: 'command', command })), 300);
  };
}

const root = join(import.meta.dirname, '../..');
const port = Number(process.argv[2] ?? 7777);
const server = await createKeepsServer({
  port,
  cardsDir: join(root, 'cards'),
  botWeights: join(root, 'packages/learn/demo/weights/midstrike.bin'),
  botName: 'Midstrike',
  botDelay: () => 300,
  extraRoutes: (req, res, path) => {
    if (path !== '/test/fill') return false;
    const query = new URL(req.url ?? '', 'http://localhost').searchParams;
    const code = String(query.get('code') ?? '').toUpperCase();
    const players = Math.min(3, Number(query.get('players') ?? 1));
    for (let i = 1; i <= players; i++) seatPlayer(port, code, `Robot ${i}`);
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`${players} joining ${code}`);
    return true;
  },
});
console.log(`ready on ${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void server.close().then(() => process.exit(0)));
