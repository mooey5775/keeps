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
      // Chrome may still be writing its profile as it exits; retry briefly.
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
  /** Saves a PNG of the visible page, or with `fullPage` the whole scrollable page. */
  screenshot(file: string, options?: { fullPage?: boolean }): Promise<void>;
  /** Emulates a phone-sized touch screen. */
  emulatePhone(): Promise<void>;
  /** Overrides the browser's user agent for this tab (takes effect on the next navigation). */
  setUserAgent(userAgent: string): Promise<void>;
  /** Moves the real mouse pointer over the first element matching `selector`. */
  hover(selector: string): Promise<void>;
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
      // A half-loaded page can throw (no body yet); that just means "not yet".
      if (await evaluate<boolean>(expression).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  // A new tab starts as a blank page that already counts as loaded; wait for the real one.
  await waitFor(`location.href !== 'about:blank' && document.readyState === 'complete' && !!document.body`, 'the page to load');
  // Collect uncaught errors so a broken page fails the check.
  await evaluate(`window.__errors = []; addEventListener('error', (e) => __errors.push(String(e.message)));`);

  return {
    evaluate,
    waitFor,
    waitForText: (text, ms) => waitFor(`!!document.body && document.body.innerText.includes(${JSON.stringify(text)})`, `"${text}"`, ms),
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
        // React tracks the native value setter, so set it through the element's own prototype.
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    },
    async screenshot(file, { fullPage = false } = {}) {
      let clip: object | undefined;
      if (fullPage) {
        const metrics = (await send('Page.getLayoutMetrics')).result as { cssContentSize: { width: number; height: number } };
        clip = { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 };
      }
      const response = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
      writeFileSync(file, Buffer.from(String(response.result?.data), 'base64'));
    },
    // Reloading clears the collector; treat that as no errors since.
    errors: () => evaluate<string[]>('window.__errors ?? []'),
    async setUserAgent(userAgent) {
      await send('Network.setUserAgentOverride', { userAgent });
    },
    async hover(selector) {
      const point = await evaluate<{ x: number; y: number } | null>(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!point) throw new Error(`nothing matches ${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await sleep(150);
    },
    async emulatePhone() {
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await sleep(200);
    },
    close: () => socket.close(),
  };
}
