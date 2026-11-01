// The app's own server (local-server.ts): its rooms are the website's, by the same connection code, and one no one is
// connected to is closed (the app takes a game up again from what it kept, not by a seat's token).
import type { ServerMessage } from '@keeps/protocol';
import { describe, expect, it } from 'vitest';
import { LocalServer } from '../local-server.ts';

const deps = { token: () => `t${Math.random()}`, id: () => `i${Math.random()}`, seed: () => 's', random: Math.random, now: Date.now };

describe("the app's own server", () => {
  it('makes and joins rooms as the website does, and closes one when the last person in it goes', () => {
    const server = new LocalServer(deps);
    const ana: ServerMessage[] = [];
    const ben: ServerMessage[] = [];
    const a = server.connect((m) => ana.push(m));
    a.receive({ t: 'create', name: 'Ana' });
    const welcome = ana.find((m) => m.t === 'welcome');
    if (welcome?.t !== 'welcome') throw new Error('no welcome');
    const b = server.connect((m) => ben.push(m));
    b.receive({ t: 'join', code: welcome.code.toLowerCase(), name: 'Ben' });
    expect(ben.some((m) => m.t === 'welcome')).toBe(true);
    expect(server.open).toBe(1);
    a.close();
    expect(server.open).toBe(1); // Ben is still there
    b.close();
    expect(server.open).toBe(0);
    // Its code finds nothing now: a seat's token resumes nothing.
    const c = server.connect((m) => ana.push(m));
    c.receive({ t: 'resume', code: welcome.code, token: welcome.token });
    expect(ana.at(-1)).toEqual({ t: 'gone' });
  });
});
