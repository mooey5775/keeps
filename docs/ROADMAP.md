# Keeps roadmap

Status: plan, 2026-10-21. The game is live at https://playkeeps.online (one Fly machine, all state in memory).

Two goals:

1. **More like chess.com:** accounts, rankings, game history.
2. **Play against the computer:** bots, up to an AlphaZero-style engine.

Keeps has hidden information (hands, piles, the face-down Duplicity card), randomness (shuffles, Legerdemain), and 2 to 4 players. Plain Elo and plain AlphaZero both assume two players with full information and no luck, so both goals need adapted versions.

## Phase 0: Persistence (the foundation for both)

Today every room and game lives in the server's memory, so a deploy or crash ends every game in progress.

- **Database:** SQLite on a Fly volume. One machine is enough for a long time, and SQLite needs no separate service. Back it up off the machine (e.g. Litestream to object storage).
- **Games survive restarts:** a game is fully determined by its options (including the seed) and its command list. That's exactly the replay log we already write. Store rooms and their logs in the database, and on startup replay each unfinished game to restore it. Players reconnect with their existing seat tokens.
- **Game archive and review:** finished games are kept. A review screen steps through a game move by move from any player's point of view, using the engine's trace and `eventsFor`. This is chess.com's "game review" without the analysis, which comes later from the bot.
- **Deploys stop ending games.** Today we wait for the machine to go idle before deploying.

## Phase 1: Play against the computer

Independent of accounts, and fun right away. Bots also fill seats that are ghosts today.

1. **Rules-based bot.** A hand-written strategy: count coins, end the round when ahead and the tie-break is in its favor, chase the three Tokens, get rid of Blunder, avoid feeding Interest or Retribution. It picks from `legalCommands`, so it can never make an illegal move. Quick to build, and the baseline every later bot must beat.
2. **Search bot: information-set Monte Carlo tree search (ISMCTS).** The standard strong approach for hidden-information card games:
   - **Determinize:** sample the hidden cards (other hands, pile orders, the face-down card) in a way consistent with everything the bot has seen: its own looks, public reveals, deductions such as an opponent's pile character.
   - Play out many possible futures from each sample and pick the move that does best across them.
   - The engine is well suited: deterministic, pure, every legal move listed, and any position can be built with `buildPosition`.
   - **Prerequisite: engine speed.** `apply()` currently deep-copies the whole state on every command. Search needs thousands of moves per second, so add a fast path for simulation (in-place apply with undo, or a cheaper copy) and benchmark it.
3. **Bot seats in rooms.** The host can add bots at three or so difficulty levels (search budget) instead of ghosts. Bots run on the server, or in the browser for pass-and-play and puzzles.

## Phase 2: Accounts and rankings

- **Sign-in:** Discord or Google login, no passwords to store. Playing as a guest without an account stays as it is.
- **Profiles:** name, game history (from Phase 0), stats such as win rate, token wins, and favorite cards.
- **Ratings:**
  - **Rating system:** OpenSkill (an open-source relative of TrueSkill) rather than Elo, because it rates finishing positions in multiplayer games.
  - **Separate ratings per player count:** two-, three- and four-player Keeps play very differently, ghost piles included.
  - **Rated games use fixed settings**, such as first to 3 marks and a random first player. Casual games keep every option.
  - **Finishing order:** by marks, with ties broken by the last round's coins.
- **Leaderboards:** among friends first. Global matchmaking (queues by player count and rating) only makes sense once there are enough players online.
- **Integrity:** hidden information means two players can quietly team up against a third in 3–4 player games. Possible responses: rate only 2-player games at first, look for patterns, or rely on friends playing fair.

## Phase 3: Learned engine (AlphaZero-style)

- **Self-play training:** neural networks guide the search in place of random playouts, as in strong bots for games like Skat and Doppelkopf. AlphaZero itself assumes full information; the methods that handle hidden information (determinized search with learned guidance, or ReBeL / Student of Games-style approaches) are the ones to adapt.
- **Moves as a scored list:** the number of legal moves varies wildly (Providence pairs, Tithes reorderings), so the network scores each legal command from `legalCommands` rather than choosing from a fixed list.
- **Training setup:** the TypeScript engine runs self-play in Node worker processes. The trainer is Python with PyTorch, talking to Node over a simple line-based connection. Trained models are exported to ONNX and run in Node (`onnxruntime-node`) or in the browser (`onnxruntime-web`).
- **Analysis:** with a strong model, post-game review gets win chances and suggested moves, completing the chess.com-style review from Phase 0.

## Before going public

Accounts, public leaderboards and matchmaking turn a private game for friends into a public product built on Keeps' rules and art. That needs permission from David & Elaina Buffkin, who may well be interested (a digital version, puzzles, and sales through their Amazon link). Ask before Phase 2 goes public.

## Order

1. Phase 0: persistence, restoring games after restarts, archive and review.
2. Phase 1: rules-based bot, then the search bot (after the engine speed work), then bot seats.
3. Phase 2: accounts and ratings, once it's clear whether this stays a friends' game or goes public.
4. Phase 3: learned engine and analysis.
