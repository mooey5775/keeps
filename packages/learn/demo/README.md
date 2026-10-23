# Search demo and coach (local only)

The site with a bot that plays by test-time search, plus local pages that show what it thinks.

```
cd packages/learn/demo
BOT=vrpo1 SEARCH_WORLDS=512 node server.ts
```

- **The game:** http://localhost:8788
- **Bot insight:** http://localhost:8789. The bot's chance to win before and after search, and its candidate moves.
- **Spectator view:** http://localhost:8789/spectate. Both hands and the unredacted log, so keep it off a human opponent's screen.
- **Coach:** http://localhost:8789/coach. What the bot would play in your seat, from your information only.

Port 8789 listens on 127.0.0.1 only.

**Options:**
- `BOT=<name>`: plays `weights/<name>.bin` (e1 by default).
- `SEARCH_WORLDS`: worlds per decision (256 by default).
- `SEARCH_MODE=sample`: Ataraxos's sampling, π·exp(βQ), instead of the best rollout move.
- `SEARCH_ROLLOUTS=sampled`: rollouts sample the policy instead of taking its top move.
- `/settings?worlds=N`: changes the world count while the server runs.

**Weights:** `weights/` is not committed. Export a policy with the JAX environment:

```
cd bot && PYTHONPATH=. .venv/bin/python -m keeps_bot.export <policy-STEP.pkl> --out ../packages/learn/demo/weights/<name>.bin --fixture /tmp/parity.bin
```

The pickle's file name must end in its step number (`policy-5450.pkl`). VRPO's actor has no value head, so its pages show no network estimate.

**Games** are saved to `data/replays/` (not committed).

## How the search works (`search-bot.ts`, `rollout-worker.ts`)

At each decision with a real choice:

1. **Sample worlds:** draw WORLDS hidden states exactly from what the bot knows (`../src/worlds.ts`).
2. **Play every candidate out:** play each candidate move to the end of the round in every world. The bot's own network plays both sides, taking its top move.
3. **Score:** Q is a candidate's average result.
4. **Choose:** best-Q mode plays the move with the highest Q. Moves within 0.05 of the best count as tied, and the network's probability breaks the tie.

Pile reorders (Tithes) can't list every order, so they are searched one card at a time. At each step the candidates are "this card next, then the network's order for the rest".

The search only sees the opponent replies its own network would play. A sharper opponent's best line can be invisible to it.

## Tools

- `searchmatch.ts`: search against search between two networks, each deal played in both seats.
- `searchat.ts`: the search at one decision of a saved replay, with greedy and sampled rollouts.
- `ordertest.ts`: the search at real Tithes reorders from self-play.
- `coachtest.mjs`, `wsclient.mjs`, `wstunnel.mjs`: scripted human clients for checking a running server.
