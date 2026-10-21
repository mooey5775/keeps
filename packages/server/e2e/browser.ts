// A minimal Chrome DevTools Protocol driver for end-to-end checks:
// headless Chrome, one tab per page, DOM driven through Runtime.evaluate.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

export interface Browser {
  port: number;
  process: ChildProcess;
  profile: string;
  close(): void;
}

export async function launch(port: number): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), 'keeps-e2e-'));
  const child = spawn(
    process.env.CHROME ?? 'google-chrome',
    ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await sleep(100);
    }
  }
  return {
    port,
    process: child,
    profile,
    close() {
      child.kill();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Page {
  evaluate<T = unknown>(expression: string): Promise<T>;
  waitFor(expression: string, what: string, ms?: number): Promise<void>;
  waitForText(text: string, ms?: number): Promise<void>;
  text(): Promise<string>;
  path(): Promise<string>;
  /** Clicks the first enabled button whose text or accessible name contains `label`. */
  click(label: string): Promise<void>;
  type(selector: string, value: string): Promise<void>;
  screenshot(file: string): Promise<void>;
  /** Emulates a phone-sized touch screen. */
  emulatePhone(): Promise<void>;
  errors(): Promise<string[]>;
  close(): void;
}

export async function open(browser: Browser, url: string): Promise<Page> {
  const target = (await (await fetch(`http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()) as {
    webSocketDebuggerUrl: string;
  };
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.once('open', resolve));
  let nextId = 0;
  const pending = new Map<number, (message: { result?: Record<string, unknown> }) => void>();
  socket.on('message', (data) => {
    const message = JSON.parse(String(data)) as { id?: number; result?: Record<string, unknown> };
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
  });
  const send = (method: string, params: object = {}) =>
    new Promise<{ result?: Record<string, unknown> }>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const result = response.result as { result?: { value?: T }; exceptionDetails?: unknown } | undefined;
    if (result?.exceptionDetails) throw new Error(`page error: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
    return result?.result?.value as T;
  };
  const waitFor = async (expression: string, what: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate<boolean>(expression)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  await waitFor('document.readyState === "complete"', 'the page to load');
  // Collect uncaught errors so a broken page fails the check.
  await evaluate(`window.__errors = []; addEventListener('error', (e) => __errors.push(String(e.message)));`);

  return {
    evaluate,
    waitFor,
    waitForText: (text, ms) => waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, `"${text}"`, ms),
    text: () => evaluate<string>('document.body.innerText'),
    path: () => evaluate<string>('location.pathname'),
    async click(label) {
      // Retry briefly: right after navigation React may not have rendered yet.
      for (let attempt = 0; attempt < 40; attempt++) {
        const clicked = await evaluate<boolean>(`(() => {
          const label = ${JSON.stringify(label)};
          const el = [...document.querySelectorAll('button, [role=button]')].find((b) => !b.disabled
            && ((b.innerText || '').includes(label) || (b.getAttribute('aria-label') || '').includes(label)));
          if (!el) return false;
          el.click();
          return true;
        })()`);
        if (clicked) {
          await sleep(80);
          return;
        }
        await sleep(100);
      }
      throw new Error(`no enabled button "${label}"`);
    },
    async type(selector, value) {
      await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    },
    async screenshot(file) {
      const response = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(String(response.result?.data), 'base64'));
    },
    // Reloading clears the collector; treat that as no errors since.
    errors: () => evaluate<string[]>('window.__errors ?? []'),
    async emulatePhone() {
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await sleep(200);
    },
    close: () => socket.close(),
  };
}
