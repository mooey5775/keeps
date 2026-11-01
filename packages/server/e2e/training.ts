// Training mode in a real browser: a game against the bot, training switched on, the bot's suggestion
// shown for the player's move. Saves screenshots to the directory given (default: /tmp/keeps-training).
//   node e2e/training.ts [weights.bin] [screenshot dir]      (build the web client first)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createKeepsServer } from '../src/server.ts';
import { launch, open } from './browser.ts';

const root = join(import.meta.dirname, '../../..');
const weights = process.argv[2] ?? join(root, 'packages/bot/weights/bot.bin');
const dir = process.argv[3] ?? '/tmp/keeps-training';
mkdirSync(dir, { recursive: true });

const server = await createKeepsServer({
  port: 0,
  webDir: join(root, 'packages/web/dist'),
  cardsDir: join(root, 'cards'),
  botWeights: weights,
  botName: 'Midstrike',
  botDelay: () => 300,
});
const base = `http://localhost:${(server.http.address() as { port: number }).port}`;
const browser = await launch(9333);
try {
  const page = await open(browser, base);
  await page.waitFor(`document.body.innerText.includes('Play against the bot')`, 'the home page');
  await page.type('input[placeholder="Name"]', 'Edward');
  await page.click('Play against the bot');
  await page.click('Start the game');
  await page.waitFor(`document.querySelector('.game') !== null`, 'the game table');
  await page.click('Training mode: off');
  await page.waitFor(`document.body.innerText.includes('Training mode: on')`, 'training mode on');
  // Wait for one of the player's own decisions, playing the suggested move until one shows.
  await page.waitFor(`document.querySelector('.training') !== null`, 'the suggestion', 20000);
  const text = await page.evaluate<string>(`document.querySelector('.training').innerText`);
  console.log(`suggestion box: ${text.replace(/\n/g, ' | ')}`);
  if (!text.includes('Midstrike would play')) throw new Error('the suggestion box does not name the bot');
  await page.screenshot(join(dir, 'training-desktop.png'));
  console.log(`saved ${join(dir, 'training-desktop.png')}`);
  // Play on (the first option each time) until a decision with alternatives, and show that too.
  for (let i = 0; i < 40 && !(await page.evaluate<boolean>(`document.querySelector('.training li') !== null`)); i++) {
    await page.evaluate(`document.querySelector('.options button:not([disabled])')?.click()`);
    await new Promise((r) => setTimeout(r, 700));
  }
  if (await page.evaluate<boolean>(`document.querySelector('.training li') !== null`)) {
    console.log(`with alternatives: ${(await page.evaluate<string>(`document.querySelector('.training').innerText`)).replace(/\n/g, ' | ')}`);
    await page.screenshot(join(dir, 'training-alternatives.png'));
    console.log(`saved ${join(dir, 'training-alternatives.png')}`);
  }
} finally {
  browser.close();
  await server.close();
}
process.exit(0);
