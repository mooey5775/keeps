// Browser-side PostHog, for session replay and the few events only the browser
// knows (product events come from the server). Loaded only when the server says
// it's configured, and as a separate chunk so the game doesn't wait for it.

/** PostHog, once it's started (null: not configured, or not loaded yet). */
let started: { capture(event: string, properties?: Record<string, unknown>): void } | null = null;

/** An event only the browser knows of (a round's review opened); nothing if analytics is off. */
export function capture(event: string, properties: Record<string, unknown> = {}): void {
  started?.capture(event, properties);
}

export async function startSessionReplay(clientId: string): Promise<void> {
  let config: { posthogKey?: string; posthogHost?: string };
  try {
    config = (await (await fetch('/config.json')).json()) as typeof config;
  } catch {
    return;
  }
  if (!config.posthogKey) return;
  const { default: posthog } = await import('posthog-js');
  posthog.init(config.posthogKey, {
    api_host: config.posthogHost ?? 'https://us.i.posthog.com',
    // The same anonymous id the server uses, so recordings link to game events.
    bootstrap: { distinctID: clientId },
    // Game events come from the server; the browser only records sessions.
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_surveys: true,
    // Record the screen as the player saw it; recordings are only for the site's owner.
    session_recording: { maskAllInputs: false },
  });
  started = posthog;
}
