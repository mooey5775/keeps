# Keeps online

A web version of [Keeps](https://www.keepsgame.com), the card game by David & Elaina Buffkin, for playing with friends: online in shared rooms, pass-and-play on one device, or solo with the 25 official puzzles.

The card art and rules belong to their creators. This is for private play among friends; don't host it publicly without their permission.

## Running it

Needs Node 24+ and pnpm.

```sh
pnpm install
pnpm start          # builds the web client, serves everything on http://localhost:8787
```

Then open the page, create a room, and send the link (`/r/ABCD`) to your friends. To play remotely, they need to reach your server: a cheap VPS, or a tunnel such as `cloudflared tunnel --url http://localhost:8787`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP and WebSocket port |
| `KEEPS_DATA_DIR` | `./data` | Where replay logs are written (`replays/<room>-<time>.jsonl`) |

For development, `pnpm dev` runs the server and the Vite dev server together. Open the URL Vite prints; it proxies `/ws` to the server.

## How a game works

- **Rooms:** no accounts. The first player in a room is the host, who picks the marks needed to win and who starts, then starts the game with 2 to 4 players. Seats are random. With fewer than four players, the empty seats keep their piles as "ghosts".
- **Reconnecting:** each browser keeps a token per room, so reloading or losing the connection puts you back in your seat. Late joiners watch as spectators.
- **Undo:** any player can propose undoing the last move. It happens if everyone else who is connected agrees. It's for misclicks: it works within the current round only.
- **Playing:** click a card, pile or keep to see what you can do with it, then click a target. The side panel always lists every option as a button.

## Layout

| Path | What it is |
|---|---|
| `packages/engine` | The rules engine: pure TypeScript, no dependencies, shared by the server and the browser. See [docs/ENGINE.md](docs/ENGINE.md). |
| `docs/ROADMAP.md` | Plans: persistence, bots, accounts and ratings. |
| `packages/server` | Node server: rooms, WebSockets, static files. |
| `packages/protocol` | Message types shared by the server and the client. |
| `packages/web` | React client. |
| `rules/` | The official rules card, rules reference, clarifications, and puzzles. |
| `cards/` | Original card scans. |

## Tests

```sh
pnpm test           # every package's unit tests
pnpm test:strict    # also fails if any rule, clarification, ruling or puzzle lacks a test
pnpm typecheck
pnpm e2e            # builds the client and drives it in headless Chrome
```

The engine's tests are tied to [`test/spec-manifest.ts`](packages/engine/test/spec-manifest.ts): every rule on the rules card (R-\*), every official clarification (C-\*), every ruling we made where the rules are unclear (Q-\*), specific card behaviors (K-\*) and every official puzzle (P-\*) has a named test.

## Debugging a game

Every game writes a replay log. To see exactly what happened, with every trigger and what caused it:

```sh
pnpm --filter @keeps/engine replay data/replays/ABCD-<time>.jsonl            # everything
pnpm --filter @keeps/engine replay data/replays/ABCD-<time>.jsonl --as 2     # as seat 2 saw it
```

A rules bug found in a real game can be added as a regression test from its replay log.
