// Screenshots of every sandbox scenario (one per kind of decision), on desktop
// and on a phone, for comparing the table UI before and after a change.
// Run: node e2e/sandbox-shots.ts <out dir> (build the web client first).
// When an option button opens a group ("Play Dagger…"), the first one is also
// opened and shot as <name>-2.png.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createKeepsServer } from '../src/server.ts';
import { launch, open, sleep } from './browser.ts';

const root = join(import.meta.dirname, '../../..');
const webDir = join(root, 'packages/web/dist');
const outDir = resolve(process.argv[2] ?? join(root, 'screenshots/sandbox'));
if (!existsSync(webDir)) {
  console.error('Build the web client first: pnpm --filter @keeps/web build');
  process.exit(2);
}
const { SCENARIOS } = await import('../../web/src/game/scenarios.ts');

const server = await createKeepsServer({ port: 0, webDir, cardsDir: join(root, 'cards') });
const base = `http://localhost:${(server.http.address() as { port: number }).port}`;
const browser = await launch(9461);
try {
  for (const device of ['desktop', 'phone'] as const) {
    const dir = join(outDir, device);
    mkdirSync(dir, { recursive: true });
    for (const scenario of SCENARIOS) {
      const page = await open(browser, `${base}/sandbox/${scenario.name}`);
      if (device === 'phone') {
        await page.emulatePhone();
        await page.evaluate('location.reload()');
        await sleep(800);
      }
      await page.waitForText(scenario.title);
      await sleep(400);
      await page.screenshot(join(dir, `${scenario.name}.png`), { fullPage: true });
      const opened = await page.evaluate<boolean>(`(() => {
        const group = document.querySelector('.options .option.group');
        if (!group) return false;
        group.click();
        return true;
      })()`);
      if (opened) {
        await sleep(300);
        await page.screenshot(join(dir, `${scenario.name}-2.png`), { fullPage: true });
      }
      page.close();
      console.log(`${device}/${scenario.name}${opened ? ' (+ opened group)' : ''}`);
    }
  }
} finally {
  browser.close();
  await server.close();
}
console.log(`Saved to ${outDir}`);
