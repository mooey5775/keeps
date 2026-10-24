// The hover preview of a card must go away when the card itself does: in a pass-and-play game, hover
// a card in hand, click it to play it, and once it has left the hand the preview must not still show it.
//   node e2e/preview.ts      (build the web client first)
import { join } from 'node:path';
import { createKeepsServer } from '../src/server.ts';
import { launch, open, sleep } from './browser.ts';

const root = join(import.meta.dirname, '../../..');
const server = await createKeepsServer({ port: 0, webDir: join(root, 'packages/web/dist'), cardsDir: join(root, 'cards') });
const base = `http://localhost:${(server.http.address() as { port: number }).port}`;
const browser = await launch(9334);
let checked = 0;
const stuck: string[] = [];
try {
  const page = await open(browser, `${base}/hotseat`);
  await page.click('Start');
  const handCards = `[...document.querySelectorAll('.hand-cards .card')].map((c) => c.getAttribute('aria-label'))`;
  for (let step = 0; step < 200 && checked < 6; step++) {
    await sleep(150);
    // Between turns: hand the device over (the curtain's button).
    if (!(await page.evaluate<boolean>(`document.querySelector('.you-decide') !== null`))) {
      await page.evaluate(`document.querySelector('button.primary')?.click()`);
      continue;
    }
    const playable = await page.evaluate<string | null>(`document.querySelector('.hand-cards button.card.clickable')?.getAttribute('aria-label') ?? null`);
    if (!playable) {
      await page.evaluate(`document.querySelector('.options button:not([disabled])')?.click()`); // usually a draw
      continue;
    }
    const before = await page.evaluate<string[]>(handCards);
    // The pointer comes from off the cards (a pointer that hasn't moved enters nothing).
    await page.mouseTo(1, 1);
    if (await page.evaluate<boolean>(`document.querySelector('.card-preview') !== null`)) throw new Error('a preview shows with the pointer off the cards');
    await page.hover('.hand-cards button.card.clickable');
    if (!(await page.evaluate<boolean>(`document.querySelector('.card-preview') !== null`))) throw new Error('hovering a card shows no preview');
    await page.evaluate(`document.querySelector('.hand-cards button.card.clickable').click()`);
    await sleep(150);
    // Finish the move if it needs more choices (a target): take the first option until it's done.
    for (let i = 0; i < 4 && (await page.evaluate<string[]>(handCards)).includes(playable); i++) {
      await page.evaluate(`document.querySelector('.options button:not([disabled])')?.click()`);
      await sleep(150);
    }
    const after = await page.evaluate<string[]>(handCards);
    if (after.length === before.length || after.includes(playable)) continue; // the card didn't leave the hand
    checked++;
    const previewing = await page.evaluate<string | null>(`document.querySelector('.card-preview img')?.getAttribute('src') ?? null`);
    if (previewing) stuck.push(`${playable}: still previewing ${previewing.split('/').pop()}`);
  }
  console.log(`played ${checked} cards from the hand after hovering them; preview left up afterwards: ${stuck.length ? stuck.join('; ') : 'never'}`);
} finally {
  browser.close();
  await server.close();
}
process.exit(stuck.length || checked === 0 ? 1 : 0);
