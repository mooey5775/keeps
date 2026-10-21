// Screenshots of every screen, on desktop and on a phone, for eyeballing the
// UI. Run: pnpm screenshots (from the repo root; it builds the web client
// first). Writes screenshots/<desktop|phone>/NN-<screen>.png (not committed).
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createKeepsServer } from '../src/server.ts';
import { launch, open, sleep, type Browser, type Page } from './browser.ts';

const root = join(import.meta.dirname, '../../..');
const webDir = join(root, 'packages/web/dist');
if (!existsSync(webDir)) {
  console.error('Build the web client first: pnpm --filter @keeps/web build');
  process.exit(2);
}
const outDir = join(root, 'screenshots');
rmSync(outDir, { recursive: true, force: true });

const server = await createKeepsServer({ port: 0, webDir, cardsDir: join(root, 'cards') });
const base = `http://localhost:${(server.http.address() as { port: number }).port}`;

async function shootAll(device: 'desktop' | 'phone', port: number): Promise<void> {
  const dir = join(outDir, device);
  mkdirSync(dir, { recursive: true });
  // Two browsers: the second is a different person (no shared storage).
  const [me, friend] = (await Promise.all([launch(port), launch(port + 1)])) as [Browser, Browser];
  let n = 0;
  const shot = async (page: Page, name: string) => {
    await sleep(400);
    await page.screenshot(join(dir, `${String(++n).padStart(2, '0')}-${name}.png`), { fullPage: true });
    console.log(`${device}/${name}`);
  };
  const visit = async (browser: Browser, path: string, ready: string): Promise<Page> => {
    const page = await open(browser, `${base}${path}`);
    if (device === 'phone') {
      await page.emulatePhone();
      await page.evaluate('location.reload()');
      await sleep(800);
    }
    await page.waitForText(ready);
    return page;
  };

  try {
    const home = await visit(me, '/', 'Create a room');
    await shot(home, 'home');

    const list = await visit(me, '/puzzles', 'Puzzles');
    await shot(list, 'puzzle-list');

    const puzzle = await visit(me, '/puzzles/P-01', 'Draw from your pile');
    await shot(puzzle, 'puzzle');
    await puzzle.click('Tell the developer');
    await puzzle.waitForText('Send to the developer');
    await shot(puzzle, 'rule-dispute-form');
    await puzzle.type('textarea', 'Example report from the screenshot script.');
    await puzzle.click('Send to the developer');
    await puzzle.waitForText('Thanks!');
    await shot(puzzle, 'rule-dispute-sent');
    await puzzle.click('Back to the game');
    await puzzle.click('Draw from your pile');
    await puzzle.waitForText('1 action left');
    await puzzle.click('Draw from your pile');
    await puzzle.waitForText('Solved!');
    await shot(puzzle, 'puzzle-solved');

    const hotseat = await visit(me, '/hotseat', 'Pass and play');
    await shot(hotseat, 'pass-and-play-setup');
    await hotseat.click('Start');
    await hotseat.waitForText('Pass to');
    await shot(hotseat, 'pass-and-play-curtain');
    await hotseat.click('show my cards');
    await hotseat.waitForText('hand');
    await shot(hotseat, 'pass-and-play-table');

    // Online: I create a room, a friend joins from another browser, we play.
    home.close();
    const host = await visit(me, '/', 'Create a room');
    await host.type('input[placeholder="Name"]', 'Edward');
    await host.click('Create a room');
    await host.waitForText('Players (1/4)');
    await shot(host, 'lobby-host');
    const code = await host.evaluate<string>(`document.querySelector('.room-code').textContent`);

    const guest = await visit(friend, `/r/${code}`, 'Your name');
    await shot(guest, 'join-form');
    await guest.type('input', 'Friend');
    await guest.click('Join');
    await guest.waitForText('Waiting for the host');
    await shot(guest, 'lobby-guest');

    await host.waitForText('Players (2/4)');
    await host.click('Start the game');
    await host.waitFor(`document.querySelector('.game') !== null`, 'the game table');
    await shot(host, 'game-start');
    // Play a few moves, whoever's turn it is, so the log and keeps fill in.
    for (let i = 0; i < 6; i++) {
      for (const page of [host, guest]) {
        const clicked = await page.evaluate<boolean>(
          `(() => { const b = document.querySelector('.options button:not([disabled])'); if (!b) return false; b.click(); return true; })()`,
        );
        if (clicked) await sleep(300);
      }
    }
    await shot(host, 'game-in-progress');
    await shot(guest, 'game-other-player');

    // The same browser opening the room again: asks before taking the seat.
    const second = await visit(me, `/r/${code}`, 'open in another tab');
    await shot(second, 'already-open-in-another-tab');
    await second.click('Play here instead');
    await host.waitForText('playing in another tab');
    await shot(host, 'replaced-by-another-tab');

    const gone = await visit(friend, '/r/ZZZZ', 'Your name');
    await gone.type('input', 'Friend');
    await gone.click('Join');
    await gone.waitForText('No room called');
    await shot(gone, 'no-such-room');
  } finally {
    me.close();
    friend.close();
  }
}

try {
  await shootAll('desktop', 9421);
  await shootAll('phone', 9431);
  console.log(`\nSaved to ${outDir}`);
} finally {
  await server.close();
}
