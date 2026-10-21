// End-to-end smoke test of the whole stack in real browsers: the built web
// client served by the real server, driven through headless Chrome.
// Run: pnpm e2e (from the repo root; it builds the web client first).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createKeepsServer } from '../src/server.ts';
import { launch, open, sleep, type Browser, type Page } from './browser.ts';

const root = join(import.meta.dirname, '../../..');
const webDir = join(root, 'packages/web/dist');
if (!existsSync(webDir)) {
  console.error('Build the web client first: pnpm --filter @keeps/web build');
  process.exit(2);
}

const server = await createKeepsServer({ port: 0, webDir, cardsDir: join(root, 'cards') });
const address = server.http.address();
if (!address || typeof address === 'string') throw new Error('no server port');
const base = `http://localhost:${address.port}`;
const browsers: Browser[] = [await launch(9401), await launch(9402)];
const [a, b] = browsers as [Browser, Browser];

const results: string[] = [];
let failed = false;
async function check(name: string, run: () => Promise<Page[]>) {
  let pages: Page[] = [];
  try {
    pages = await run();
    for (const page of pages) {
      const errors = await page.errors();
      if (errors.length > 0) throw new Error(`uncaught page errors: ${errors.join('; ')}`);
    }
    results.push(`PASS  ${name}`);
  } catch (error) {
    failed = true;
    results.push(`FAIL  ${name}: ${(error as Error).message}`);
  } finally {
    for (const page of pages) page.close();
  }
}

try {
  await check('home page loads', async () => {
    const page = await open(a, base);
    await page.waitForText('Create a room');
    return [page];
  });

  await check('puzzle solved with the option buttons (Humble Beginnings)', async () => {
    const page = await open(a, `${base}/puzzles/P-01`);
    await page.click('Draw from your pile');
    await page.waitForText('1 action left');
    await page.click('Draw from your pile');
    await page.waitForText('Solved!');
    return [page];
  });

  await check('puzzle solved by clicking the table (Rags to Riches)', async () => {
    const page = await open(a, `${base}/puzzles/P-03`);
    await page.click('Purity');
    await page.click('Your keep');
    await page.waitForText('1 action left');
    await page.click('Sanction');
    await page.click("Right player's pile, empty");
    await page.waitForText('Solved!');
    return [page];
  });

  await check('puzzle with an opponent decision (Last Laugh 3)', async () => {
    const page = await open(a, `${base}/puzzles/P-10`);
    await page.click('Sanction');
    await page.click("Right player's pile");
    await page.click('Last Laugh');
    await page.click('Your keep');
    // The left player's forced draw is yours to make, then Last Laugh.
    await page.waitForText('deciding for the left player');
    await page.click('Draw from your pile');
    await page.waitForText('Last Laugh: take one action');
    await page.click('Play Hocus Pocus');
    await page.click('Play Resurrection');
    await page.click('Take Providence from the discard');
    await page.click('Play Providence');
    await page.click('Swap Sanction (your keep) with Purity');
    await page.waitForText('Solved!');
    return [page];
  });

  await check('online: create, join, start, play, undo, reload', async () => {
    const host = await open(a, base);
    await host.type('input', 'Ada');
    await host.click('Create a room');
    await host.waitFor('location.pathname.startsWith("/r/")', 'the room page');
    const guest = await open(b, `${base}${await host.path()}`);
    await guest.type('input', 'Bo');
    await guest.click('Join');
    await host.waitForText('Bo');
    await host.click('Start the game');
    await host.waitForText('Round 1');
    await guest.waitForText('Round 1');

    const mover = (await host.text()).includes('Your turn') ? host : guest;
    const other = mover === host ? guest : host;
    await mover.click('Draw from your pile');
    await other.waitFor('/draws a card/.test(document.body.innerText)', 'a hidden draw in the other log');

    await mover.click('Undo last move');
    await other.waitForText('asked to undo');
    await other.click('Allow undo');
    await mover.waitForText('2 actions left');

    await guest.evaluate('location.reload()');
    await sleep(1000);
    await guest.waitForText('Round 1');
    return [host, guest];
  });
} finally {
  console.log(results.join('\n'));
  for (const browser of browsers) browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
