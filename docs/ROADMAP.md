# Keeps roadmap

Status, 2026-11-01. The game is live at https://playkeeps.online: one Fly machine, one server, with Midstrike to play
against, and an iOS app (games against Midstrike on the phone, and online play on the website's server).

Two goals:

1. **More like chess.com:** accounts, rankings, game history.
2. **Play against the computer:** bots, up to an AlphaZero-style engine.

Keeps has hidden information (hands, piles, the face-down Duplicity card), randomness (shuffles, Legerdemain), and 2 to
4 players. Plain Elo and plain AlphaZero both assume two players with full information and no luck, so both goals need
adapted versions.

## Phase 0: Persistence (partly done)

- **Done:** every game's replay log is kept on a Fly volume (`keeps_data`). A room with a game in progress waits 3
  days for its players (a seat is kept through a closed tab or a dead battery). The app keeps its game on the phone and
  takes it up again after it closes (`Room.restore`).
- **To do: the website's games survive restarts.** A game is fully determined by its options (with the seed) and its
  command list, the replay log; `Room.restore` rebuilds a room from one (the app uses it). The server should keep its
  rooms' logs and restore them on startup, so a deploy stops ending games. Today we deploy only when the site is idle.
- **To do: an archive and a review** of any game: step through it move by move from any player's point of view (the
  engine's trace and `eventsFor`). Games against Midstrike already get a review of each round, with the bot's
  judgement of every move.

## Phase 1: Play against the computer (done, as Midstrike)

Done differently from the plan: not a rules-based bot then a search bot, but a network trained by self-play with a
search on top of it (Phase 3's method, early). See [docs/BOT.md](BOT.md).

- **Bot seats:** in two-player rooms, at Easy, Medium or Hard. On the server (its hand is safe there), with training
  mode and round reviews.
- **To do:** three- and four-player games (the network plays heads-up only), and bots in place of ghosts.

## Phase 2: Accounts and rankings (not started)

- **Sign-in:** Discord or Google login, no passwords to store. Playing as a guest without an account stays as it is.
- **Profiles:** name, game history (from Phase 0), stats such as win rate, token wins, and favorite cards.
- **Ratings:**
  - **Rating system:** OpenSkill (an open-source relative of TrueSkill) rather than Elo, because it rates finishing positions in multiplayer games.
  - **Separate ratings per player count:** two-, three- and four-player Keeps play very differently, ghost piles included.
  - **Rated games use fixed settings**, such as first to 3 marks and a random first player. Casual games keep every option.
  - **Finishing order:** by marks, with ties broken by the last round's coins. Leaving a game counts as losing it; a game the host ends early isn't rated.
- **Leaderboards:** among friends first. Global matchmaking (queues by player count and rating) only makes sense once there are enough players online.
- **Integrity:** hidden information means two players can quietly team up against a third in 3–4 player games. Possible responses: rate only 2-player games at first, look for patterns, or rely on friends playing fair.

## Phase 3: Learned engine (partly done)

- **Done:** self-play training (VRPO, Python and PyTorch, the TypeScript engine in Node workers), a network that
  scores each legal move one choice at a time, search at play time over sampled worlds, and a review with win
  chances and better moves (for games against Midstrike). The network runs in TypeScript (its own forward pass), on a
  GPU server for the website's search, and on the Neural Engine in the app.
- **To do:** a stronger network (the TODO list in docs/BOT.md), and analysis of any game, not only those against
  Midstrike.

## Open bugs to revisit

- **Epiphany and Prayer on a face-up pile hide the card underneath** (rules dispute, Konwoo on Midstrike,
  2026-10-25). Both say "**pick up** and look at the top card": on a pile Revelation turned face up, picking
  up the top card shows everyone the face-up card beneath it while the player decides. The engine leaves the
  cards on their piles until the choice (`effects.ts`: `epiphany`, the `prayer` branch), so that card stays
  hidden. Preferred fix: reveal the card under each picked-up face-up top to everyone, as a public event,
  with the cards left in place. That gives the same information as the table, and keeps the bot's inputs
  familiar: its belief already handles a seen card at a known pile position, while cards lifted off their
  piles mid-decision would be states it never trained on and would break its belief. Needs a clarification
  entry, engine tests, a check of the bot (belief, world sampler), and both sites deployed. Same change: a
  card taken into a hand from a face-up top (Epiphany, Prayer, Requisition) is logged hidden although
  everyone saw it (`takeIntoHand`; draws of a face-up top are already public).
- **Disputes are kept only in analytics.** Midstrike is part of the website now (one server, with its PostHog
  key), so disputes against it reach analytics like any other; but a dispute reaches nothing else. Append every
  dispute to a file on the data volume too.

## Before going public

Accounts, public leaderboards and matchmaking turn a private game for friends into a public product built on Keeps' rules and art. That needs permission from David & Elaina Buffkin, who may well be interested (a digital version, puzzles, and sales through their Amazon link). Ask before Phase 2 goes public.

## Order

1. Phase 0's rest: games that survive restarts, then the archive and review.
2. Phase 2: accounts and ratings, once it's clear whether this stays a friends' game or goes public.
3. Phase 1 and 3's rest: a stronger Midstrike, and bots for three and four players.
