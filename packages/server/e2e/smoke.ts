// End-to-end smoke test of the whole stack in real browsers: the built web
// client served by the real server, driven through headless Chrome.
// Run: pnpm e2e (from the repo root; it builds the web client first).
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeepsServer } from '../src/server.ts';
import { launch, open, sleep, type Browser, type Page } from './browser.ts';

const root = join(import.meta.dirname, '../../..');
const webDir = join(root, 'packages/web/dist');
if (!existsSync(webDir)) {
  console.error('Build the web client first: pnpm --filter @keeps/web build');
  process.exit(2);
}

const server = await createKeepsServer({
  port: 0,
  webDir,
  cardsDir: join(root, 'cards'),
  botWeights: join(root, 'packages/learn/weights/bot.bin'),
  botDelay: () => 100,
});
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
    const links = await page.evaluate<string[]>(`[...document.querySelectorAll('a')].map((a) => a.href)`);
    if (!links.some((h) => h.startsWith('https://www.amazon.com/Keeps-an-Elegant-Game/dp/B0H7TBLY5X?maas=') && h.includes('tag=maas'))) {
      throw new Error('missing the Amazon link with the creators’ attribution tags');
    }
    if (!links.includes('https://www.keepsgame.com/')) throw new Error('missing the keepsgame.com link');
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

  await check("on a phone, text fields are 16px so Safari doesn't zoom in on them (desktop keeps 14px)", async () => {
    const sizes = `[...document.querySelectorAll('input')].map((el) => getComputedStyle(el).fontSize)`;
    const desktop = await open(a, base);
    await desktop.waitForText('Create a room');
    const onDesktop = await desktop.evaluate<string[]>(sizes);
    if (onDesktop.length === 0 || onDesktop.some((s) => s !== '14px')) throw new Error(`desktop fields: ${onDesktop.join(', ')}`);

    const phone = await open(a, base);
    await phone.emulatePhone();
    await phone.evaluate('location.reload()');
    await sleep(800);
    await phone.waitForText('Create a room');
    const onPhone = await phone.evaluate<string[]>(sizes);
    if (onPhone.length === 0 || onPhone.some((s) => parseFloat(s) < 16)) throw new Error(`phone fields: ${onPhone.join(', ')}`);
    return [desktop, phone];
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

  await check('hovering any card shows the preview, clickable or not', async () => {
    const page = await open(a, `${base}/puzzles/P-12`);
    await page.waitForText('Draw from your pile');
    // An opponent's keep card can't be clicked at the start of the turn.
    await page.hover('[aria-label="Upper player\'s keep"] .card');
    const shown = await page.evaluate<boolean>(`!!document.querySelector('.card-preview img')`);
    if (!shown) throw new Error('no preview for a card that is not clickable');
    // And a clickable one (in your hand).
    await page.hover('.hand .card');
    const again = await page.evaluate<string | null>(`document.querySelector('.card-preview img')?.getAttribute('src') ?? null`);
    if (!again?.includes('Providence')) throw new Error(`preview did not follow the pointer: ${again}`);
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
    // Providence's pairs are folded by card: open Sanction's, then pick the swap.
    await page.click('Swap Sanction (your keep) with…');
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
        const handoff = buttons.find((b) => b.innerText.startsWith('Hide my cards'));
        if (handoff) { handoff.click(); return 'handoff'; }
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

  await check('pass-and-play: after your last action you still see your cards, until you hand over', async () => {
    const page = await open(a, `${base}/hotseat`);
    await page.click('Start');
    await page.click('show my cards');
    await page.waitForText('Your turn');
    const first = (await page.text()).match(/Pass and play · (.+?)’s view/)![1]!;
    const handCount = () => page.evaluate<number>(`document.querySelectorAll('.hand-cards .card').length`);
    // Play the turn out: draw, or answer whatever the drawn card asks.
    for (let i = 0; i < 12 && !(await page.text()).includes('Hide my cards'); i++) {
      if ((await page.text()).includes('Draw from your pile')) await page.click('Draw from your pile');
      else await page.evaluate(`document.querySelector('.options .option')?.click()`);
      await sleep(150);
    }
    const text = await page.text();
    if (!text.includes('Hide my cards and pass to')) throw new Error('no handoff after the turn');
    // Still this player's own view, with their cards, and nothing to click.
    if (!text.includes(`${first}’s view`)) throw new Error('the view changed before the handoff');
    if ((await handCount()) === 0 && !text.includes('no cards')) throw new Error('hand not shown');
    if ((await page.evaluate<number>(`document.querySelectorAll('.options .option').length`)) !== 0) throw new Error('options still offered after the turn');
    await page.click('Hide my cards');
    await page.waitForText('Pass to');
    if ((await page.evaluate<number>(`document.querySelectorAll('.card').length`)) !== 0) throw new Error('cards visible behind the curtain');
    await page.click('show my cards');
    await page.waitFor(`!document.body.innerText.includes('${first}’s view')`, 'the next player’s view');
    return [page];
  });

  await check('online: create, join, start, play, undo, reload', async () => {
    const host = await open(a, base);
    await host.type('input', 'Ada');
    await host.click('Create a room');
    await host.waitFor('location.pathname.startsWith("/r/")', 'the room page');
    // The code is spelled out for reading aloud, e.g. "Mike · Tango · Uniform · Charlie".
    const code = (await host.path()).slice(3);
    await host.waitFor(`/^${code.split('').map((c) => `${c}[a-z-]+`).join(' · ')}$/m.test(document.body.innerText)`, 'the NATO spelling of the room code');
    await host.screenshot(`${process.env.E2E_SHOTS ?? '/tmp'}/lobby.png`);
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
  await check('against the bot: one click from home, and it takes its turns', async () => {
    const page = await open(b, base);
    await page.waitForText('Play against the bot');
    await page.type('input[placeholder="Name"]', 'Solo');
    await page.click('Play against the bot');
    await page.waitForText('only plays two-player games');
    await page.waitForText('2 of 2');
    await page.click('Start the game');
    await page.waitFor(`document.querySelector('.game') !== null`, 'the game table');
    // Play our turns until the bot has drawn or played in its own.
    const botMoved = `/Bot (draws|plays)/.test(document.querySelector('.log')?.innerText ?? document.body.innerText)`;
    for (let i = 0; i < 40 && !(await page.evaluate<boolean>(botMoved)); i++) {
      await page.evaluate(`document.querySelector('.options button:not([disabled])')?.click()`);
      await sleep(250);
    }
    await page.waitFor(botMoved, 'a move by the bot');
    return [page];
  });

  await check('joining with a code from the home page goes straight into the lobby', async () => {
    const host = await open(a, base);
    await host.type('input[placeholder="Name"]', 'Ada');
    await host.click('Create a room');
    await host.waitFor('location.pathname.startsWith("/r/")', 'the room page');
    const code = (await host.path()).slice(3);

    const guest = await open(b, base);
    // This browser may remember a name from an earlier check; with none, the page says it's needed.
    await guest.waitForText('Create a room');
    await guest.type('input[placeholder="Name"]', '');
    await guest.waitForText('Enter your name to create or join a room');
    // An unknown code: the error shows right on the home page.
    await guest.type('input[placeholder="Name"]', 'Bo');
    await guest.type('input[aria-label="Room code"]', 'ZZZZ');
    await guest.click('Join');
    await guest.waitForText('No room called ZZZZ');
    if ((await guest.path()) !== '/') throw new Error(`left the home page for ${await guest.path()}`);

    await guest.type('input[aria-label="Room code"]', code);
    await guest.click('Join');
    await guest.waitFor(`location.pathname === '/r/${code}'`, 'the room page');
    await guest.waitForText('2 of 4');
    // One click: no second "Join room" form on the way.
    if ((await guest.text()).includes('Your name')) throw new Error('asked for the name again');
    await host.waitForText('Bo');
    return [host, guest];
  });

  await check('a page left open across a deploy reloads into its room once, then asks', async () => {
    // A second server with the same page but a different build id: as if the site was deployed
    // after this page loaded. (The page can't become newer here, so after its one reload it asks.)
    const otherDir = mkdtempSync(join(tmpdir(), 'keeps-deployed-'));
    cpSync(webDir, otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'build-id.txt'), 'a-newer-build');
    const deployed = await createKeepsServer({ port: 0, webDir: otherDir, cardsDir: join(root, 'cards') });
    try {
      const other = `http://localhost:${(deployed.http.address() as { port: number }).port}`;
      const page = await open(b, other);
      await page.type('input[placeholder="Name"]', 'Ada');
      await page.click('Create a room');
      await page.waitFor('location.pathname.startsWith("/r/")', 'the room page');
      await page.waitForText('Keeps was updated. Please reload this page.');
      // Still in the room (resumed after the reload), not a new one.
      await page.waitForText('1 of 4');
      if ([...deployed.rooms.values()].length !== 1) throw new Error(`expected one room, found ${deployed.rooms.size}`);
      return [page];
    } finally {
      await deployed.close();
      rmSync(otherDir, { recursive: true, force: true });
    }
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
    await host.waitForText('2 of 4');
    await second.waitForText('2 of 4');

    // Reloading the second tab keeps its own seat (Bo), not Ada's.
    await second.evaluate('location.reload()');
    await sleep(1000);
    await second.waitFor('/Bo\\s*you/.test(document.body.innerText)', 'Bo marked as you after reload');

    // A third tab can take over a seat on purpose; the old tab says so instead of going stale.
    const third = await open(a, room);
    await third.waitForText('open in another tab');
    await third.click('Play here instead');
    await third.waitForText('2 of 4');
    await second.waitForText('playing in another tab');
    await host.waitForText('2 of 4');
    return [host, second, third];
  });
} finally {
  console.log(results.join('\n'));
  for (const browser of browsers) browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
