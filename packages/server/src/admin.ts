import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RoomInfo } from './room.ts';

// The admin page: live rooms and visitors since the server started. It's
// behind HTTP basic auth (any username, password = ADMIN_TOKEN) and doesn't
// exist at all when no token is configured.

export interface Visitor {
  ip: string;
  connections: number;
  names: string[];
  firstSeen: number;
  lastSeen: number;
}

export interface AdminSnapshot {
  startedAt: number;
  now: number;
  rooms: RoomInfo[];
  visitors: Visitor[];
  /** Whether the bot is on, and which policy (or why it's off). */
  bot: string;
}

/**
 * Counts connections per IP, with the names used from it. Bounded: it keeps
 * the `maxIps` most recently seen IPs, and up to `maxNames` names for each.
 */
export class VisitorLog {
  private readonly byIp = new Map<string, { connections: number; names: Set<string>; firstSeen: number; lastSeen: number }>();
  private readonly maxIps: number;
  private readonly maxNames: number;

  constructor(maxIps = 5000, maxNames = 20) {
    this.maxIps = maxIps;
    this.maxNames = maxNames;
  }

  record(ip: string | null, name: string, now: number): void {
    if (!ip) return;
    const entry = this.byIp.get(ip) ?? { connections: 0, names: new Set<string>(), firstSeen: now, lastSeen: now };
    entry.connections++;
    if (entry.names.size < this.maxNames) entry.names.add(name);
    entry.lastSeen = now;
    // Re-insert so the map stays ordered by when each IP was last seen.
    this.byIp.delete(ip);
    this.byIp.set(ip, entry);
    if (this.byIp.size > this.maxIps) this.byIp.delete(this.byIp.keys().next().value!);
  }

  get size(): number {
    return this.byIp.size;
  }

  /** Most connections first. */
  top(limit = 50): Visitor[] {
    return [...this.byIp.entries()]
      .map(([ip, e]) => ({ ip, connections: e.connections, names: [...e.names], firstSeen: e.firstSeen, lastSeen: e.lastSeen }))
      .sort((a, b) => b.connections - a.connections || b.lastSeen - a.lastSeen)
      .slice(0, limit);
  }
}

/** Checks HTTP basic auth against the admin token. */
export function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const password = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(token);
  return password.length === expected.length && timingSafeEqual(password, expected);
}

export function serveAdmin(req: IncomingMessage, res: ServerResponse, path: string, token: string | undefined, snapshot: () => AdminSnapshot): void {
  if (!token) {
    res.writeHead(404).end('Not found');
    return;
  }
  if (!authorized(req, token)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Keeps admin"', 'content-type': 'text/plain' }).end('Unauthorized');
    return;
  }
  const data = snapshot();
  if (path === '/admin.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data, null, 2));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(renderAdmin(data));
}

const escape = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
}

export function renderAdmin({ startedAt, now, rooms, visitors, bot }: AdminSnapshot): string {
  const live = rooms.filter((r) => r.game && r.game.phase !== 'game-over');
  const connected = rooms.reduce((n, r) => n + r.players.filter((p) => p.connected).length, 0);
  const roomRows = rooms
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((r) => {
      const players = r.players
        .map((p) => {
          const marks = r.game && p.seat !== null ? ` · ${r.game.marks[p.seat]} marks` : '';
          const turn = r.game?.turnSeat === p.seat && p.seat !== null ? ' ◀ turn' : '';
          return `<li class="${p.connected ? 'on' : 'off'}">${escape(p.name)}${p.bot ? ' (bot)' : ''}${p.host ? ' (host)' : ''}${p.seat === null && r.game ? ' (watching)' : ''}${marks}${turn} <code>${escape(p.ip ?? '?')}</code></li>`;
        })
        .join('');
      const status = r.game
        ? `${escape(r.game.phase)} · round ${r.game.round} · ${r.game.commands} moves · started ${ago(now - r.game.startedAt)}`
        : 'lobby';
      return `<tr><td><b>${escape(r.code)}</b></td><td>${status}</td><td><ul>${players}</ul></td><td>${ago(now - r.lastActivity)}</td><td>${ago(now - r.createdAt)}</td></tr>`;
    })
    .join('');
  const visitorRows = visitors
    .map((v) => `<tr><td><code>${escape(v.ip)}</code></td><td>${v.connections}</td><td>${v.names.map(escape).join(', ')}</td><td>${ago(now - v.lastSeen)}</td><td>${ago(now - v.firstSeen)}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10"><title>Keeps admin</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; background: #16120d; color: #ecdfc4; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 24px; color: #d2a94d; }
  table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid #4a3b2a; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { color: #b3a283; font-weight: normal; } ul { margin: 0; padding-left: 16px; } li.off { opacity: 0.5; }
  code { color: #b3a283; } .stats span { margin-right: 24px; } .muted { color: #b3a283; }
</style></head><body>
<h1>Keeps admin</h1>
<p class="stats"><span><b>${live.length}</b> games in progress</span><span><b>${rooms.length}</b> rooms</span><span><b>${connected}</b> connected</span><span${bot.startsWith('DISABLED') ? ' style="color:#e06c5a"' : ''}>bot ${escape(bot)}</span><span class="muted">server up ${ago(now - startedAt).replace(' ago', '')} · refreshes every 10s · <a href="/admin.json" style="color:#d2a94d">JSON</a></span></p>
<h2>Rooms</h2>
${rooms.length ? `<table><tr><th>Room</th><th>Status</th><th>Players</th><th>Last activity</th><th>Created</th></tr>${roomRows}</table>` : '<p class="muted">No rooms.</p>'}
<h2>Visitors since the server started (by connections)</h2>
${visitors.length ? `<table><tr><th>IP</th><th>Connections</th><th>Names used</th><th>Last seen</th><th>First seen</th></tr>${visitorRows}</table>` : '<p class="muted">No visitors yet.</p>'}
<p class="muted">Live data only. It resets whenever the server restarts, including every time it sleeps after a few idle minutes, so "visitors" means since the last wake-up, not long-term. For history (all games, players, IPs), use PostHog.</p>
</body></html>`;
}
