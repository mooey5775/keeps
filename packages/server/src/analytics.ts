import { PostHog } from 'posthog-node';

// Server-side product analytics. Events go to PostHog when POSTHOG_KEY is set
// (production); otherwise nothing is sent anywhere (development, tests).
// Every event names the player it's about, with their IP, so PostHog can
// break down by player and place.

export interface Who {
  /** Stable anonymous id of the player's browser, or their room player id. */
  id: string;
  name: string;
  ip: string | null;
}

export interface Tracker {
  capture(event: string, who: Who, properties?: Record<string, unknown>): void;
  /** Sends anything still queued. Call before the process exits. */
  shutdown(): Promise<void>;
}

export const noTracker: Tracker = {
  capture: () => {},
  shutdown: async () => {},
};

export function createTracker(env: { POSTHOG_KEY?: string; POSTHOG_HOST?: string }): Tracker {
  if (!env.POSTHOG_KEY) return noTracker;
  const client = new PostHog(env.POSTHOG_KEY, {
    host: env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
    // Use the player's IP (sent as $ip) for location, not the server's.
    disableGeoip: false,
    // If PostHog is unreachable, keep at most this many events in memory (then drop the oldest).
    maxQueueSize: 1000,
  });
  return {
    capture(event, who, properties = {}) {
      client.capture({ distinctId: who.id, event, disableGeoip: false, properties: eventProperties(who, properties) });
    },
    shutdown: () => client.shutdown(),
  };
}

/** The properties sent with every event: the player's name and IP, plus the event's own. */
export function eventProperties(who: Who, properties: Record<string, unknown>): Record<string, unknown> {
  return {
    ...properties,
    name: who.name,
    ip: who.ip,
    // PostHog uses $ip for the location, instead of the server's address.
    ...(who.ip ? { $ip: who.ip } : {}),
    // Keep the player's latest name on their PostHog profile.
    $set: { name: who.name },
  };
}
