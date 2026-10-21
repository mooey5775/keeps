import { describe, expect, it } from 'vitest';
import { createTracker, eventProperties, noTracker } from '../src/analytics.ts';

describe('analytics', () => {
  it('sends nothing without a PostHog key', () => {
    expect(createTracker({})).toBe(noTracker);
  });

  it("every event carries the player's name and IP, and sets the name on their profile", () => {
    expect(eventProperties({ id: 'c1', name: 'Ada', ip: '203.0.113.7' }, { room: 'ABCD', card: 'chalice' })).toEqual({
      room: 'ABCD',
      card: 'chalice',
      name: 'Ada',
      ip: '203.0.113.7',
      $ip: '203.0.113.7',
      $set: { name: 'Ada' },
    });
  });

  it('leaves out $ip when the IP is unknown', () => {
    expect(eventProperties({ id: 'c1', name: 'Ada', ip: null }, {})).toEqual({ name: 'Ada', ip: null, $set: { name: 'Ada' } });
  });
});
