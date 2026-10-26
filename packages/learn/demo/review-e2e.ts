// The round review in a real browser: a round against the bot with training mode on, noting each hint's
// first move; then the round's review, whose first choice at each of your decisions must be that hint.
//   PORT=8791 INSIGHT_PORT=8792 REVIEW_SCALE=0.15 SEARCH_WORLDS=32 SEARCH_ROLLOUTS=sampled BOT=midstrike node server.ts
//   node review-e2e.ts [http://localhost:8791] [screenshot dir]      (build the web client first)
//   (E2E_NAME: the player's name, Eddie; E2E_REVIEW_MS: how long to wait for the review, 60 s)
import { mkdirSync } from 'node:fs';
import { launch, open, sleep } from '../../server/e2e/browser.ts';
const base = process.argv[2] ?? 'http://localhost:8791';
const dir = process.argv[3] ?? '/tmp/keeps-review';
mkdirSync(dir, { recursive: true });
const browser = await launch(9339);
try {
  const page = await open(browser, base);
  await page.waitFor(`document.body.innerText.includes('Play against')`, 'home');
  await page.type('input[placeholder="Name"]', process.env.E2E_NAME ?? 'Eddie');
  await page.click('Play against');
  await page.click('Start the game');
  await page.waitFor(`document.querySelector('.game') !== null`, 'table');
  await page.click('Training mode: off');
  const hints: string[] = [];
  for (let i = 0; i < 400; i++) {
    const phase = await page.evaluate<string>(`document.body.innerText.includes('Round 1 review') ? 'reviewable' : 'playing'`);
    if (phase === 'reviewable') break;
    const box = await page.evaluate<string | null>(`document.querySelector('.training:not(.review-rank)')?.innerText ?? null`);
    if (box === null || box.includes('thinking')) { await sleep(250); continue; }
    const best = await page.evaluate<string>(`document.querySelector('.training:not(.review-rank) strong')?.innerText ?? ''`);
    // A decision with only one move has no alternatives listed, and the review skips it.
    if (await page.evaluate<boolean>(`document.querySelector('.training:not(.review-rank) li') !== null`)) hints.push(best);
    // Play the second-ranked move when there is one (so the review has something to say), else the first.
    const pick = hints.length % 3 === 0 ? 1 : 0; // (counts only decisions with a choice)
    const ok = await page.evaluate<boolean>(`(() => {
      const labels = [...document.querySelectorAll('.training:not(.review-rank) strong, .training:not(.review-rank) li')].map((e) => e.childNodes[0].textContent.trim());
      const want = labels[${pick}] ?? labels[0];
      const button = [...document.querySelectorAll('.options button:not([disabled])')].find((b) => b.innerText.trim() === want);
      if (button) { button.click(); return true; }
      document.querySelector('.options button:not([disabled])')?.click();
      return false;
    })()`);
    await sleep(400);
  }
  console.log(`hints seen: ${hints.length}`);
  await page.waitFor(`document.body.innerText.includes('Round 1 review')`, 'the review button', Number(process.env.E2E_REVIEW_MS ?? 60000));
  await page.click('Round 1 review');
  await page.waitFor(`document.querySelector('.modal.review') !== null`, 'the review');
  // Wait for it to fill in.
  for (let i = 0; i < 240 && (await page.evaluate<boolean>(`document.querySelector('.review-pending') !== null`)); i++) await sleep(500);
  const firsts = await page.evaluate<string[]>(`[...document.querySelectorAll('.review-rank:not(.theirs)')].map((r) => r.querySelector('li:not(.cols) .opt').childNodes[0].textContent.trim())`);
  const mismatches = hints.map((h, i) => [h, firsts[i]]).filter(([h, f]) => h !== f);
  console.log(`your decisions in the review: ${firsts.length}; first choices differing from the live hint: ${mismatches.length}`, JSON.stringify(mismatches.slice(0, 3)));
  console.log('summary:', await page.evaluate<string>(`document.querySelector('.modal.review p:not(.note):not(.review-pending)')?.innerText ?? ''`));
  console.log('verdicts:', JSON.stringify(await page.evaluate<string[]>(`[...document.querySelectorAll('.modal.review .chip')].map((c) => c.innerText)`)));
  await page.screenshot(`${dir}/review-live.png`);
  await page.evaluate(`document.querySelector('.modal.review').scrollTop = 900`);
  await sleep(300);
  await page.screenshot(`${dir}/review-live-2.png`);
  console.log('errors', JSON.stringify(await page.errors()));
} finally { browser.close(); }
process.exit(0);
