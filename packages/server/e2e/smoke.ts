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
    // A puzzle is one round: no "next round" to offer, just the puzzle's own buttons.
    const offersNextRound = await page.evaluate<boolean>(`document.body.innerText.includes('Start the next round')`);
    if (offersNextRound) throw new Error('a finished puzzle still offers "Start the next round"');
    await page.click('Next puzzle');
    await page.waitForText('Divine Intervention');
    return [page];
  });

  await check('on a phone, taking an action does not scroll the page', async () => {
    const page = await open(a, `${base}/puzzles/P-01`);
    await page.emulatePhone();
    await page.evaluate('location.reload()');
    await sleep(800);
    await page.waitForText('Draw from your pile');
    await page.evaluate('window.scrollTo(0, 0)');
    await page.click('Draw from your pile');
    await page.waitForText('1 action left');
    await sleep(300);
    const scrolled = await page.evaluate<number>('window.scrollY');
    if (scrolled !== 0) throw new Error(`the page scrolled to y=${scrolled}`);
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

  await check('pass-and-play: 400 random clicks through every kind of prompt', async () => {
    const page = await open(a, `${base}/hotseat`);
    await page.click('Add player');
    await page.click('Add player');
    await page.click('Start');
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const step = await page.evaluate<string>(`(() => {
        const buttons = [...document.querySelectorAll('button')].filter((b) => !b.disabled);
        const curtain = buttons.find((b) => b.innerText.includes('show my cards'));
        if (curtain) { curtain.click(); return 'curtain'; }
        const confirm = buttons.find((b) => b.innerText === 'Confirm order');
        if (confirm) { confirm.click(); return 'order-pile'; }
        const options = buttons.filter((b) => b.classList.contains('option'));
        if (options.length === 0) return document.body.innerText.includes('won the game') ? 'game-over' : 'stuck';
        const pick = options[Math.floor(Math.random() * options.length)];
        const label = pick.innerText.split(/[ :]/)[0];
        pick.click();
        return label;
      })()`);
      if (step === 'stuck') throw new Error(`no options to click after ${i} steps: ${(await page.text()).slice(0, 300)}`);
      if (step === 'game-over') break;
      seen.add(step);
      await sleep(15);
    }
    if (seen.size < 5) throw new Error(`only saw ${[...seen].join(', ')}`);
    // The log keeps following the newest lines.
    const gap = await page.evaluate<number>(`(() => { const el = document.querySelector('.log'); return el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0; })()`);
    if (gap > 24) throw new Error(`the log is not scrolled to its newest line (${gap}px above the end)`);
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
  await check('same browser: a second tab joins as a new player; tabs never steal a seat silently', async () => {
    const host = await open(a, base);
    await host.type('input', 'Ada');
    await host.click('Create a room');
    await host.waitFor('location.pathname.startsWith("/r/")', 'the room page');
    const room = `${base}${await host.path()}`;

    // A second tab of the same browser is asked, and can join as someone else.
    const second = await open(a, room);
    await second.waitForText('open in another tab');
    await second.click('Join as a new player');
    await second.type('input', 'Bo');
    await second.click('Join');
    await host.waitForText('Players (2/4)');
    await second.waitForText('Players (2/4)');

    // Reloading the second tab keeps its own seat (Bo), not Ada's.
    await second.evaluate('location.reload()');
    await sleep(1000);
    await second.waitFor('/Bo\\s*you/.test(document.body.innerText)', 'Bo marked as you after reload');

    // A third tab can take over a seat on purpose; the old tab says so instead of going stale.
    const third = await open(a, room);
    await third.waitForText('open in another tab');
    await third.click('Play here instead');
    await third.waitForText('Players (2/4)');
    await second.waitForText('playing in another tab');
    await host.waitForText('Players (2/4)');
    return [host, second, third];
  });
} finally {
  console.log(results.join('\n'));
  for (const browser of browsers) browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
