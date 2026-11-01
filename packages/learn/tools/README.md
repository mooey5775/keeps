# Tools

Maintained and typechecked (`pnpm -C packages/learn typecheck`): run them from the repository's root. Each one's header
has the details. They use Midstrike's network (`packages/bot/weights/midstrike.bin`) and its search unless told
otherwise; the machine's cores but two (`THREADS`).

- **`match.ts`**: two bots against each other, each a network and a search size, every deal played from both seats.
  How a new network is held to Midstrike, or a search size to another:
  `node packages/learn/tools/match.ts packages/bot/weights/midstrike.bin@2048 packages/bot/weights/midstrike.bin@64 100`.
  Give it a GPU with `SEARCH_INFERENCE` (the socket of `training/keeps_bot/serve.py`).
- **`play.ts`**: a game against Midstrike in the terminal, one command a move (`new`, `show`, `move`, `log`, `cards`).
  For trying a network out by hand, or by an agent.
- **`searchat.ts`**: the search at one decision of a saved game: every candidate's policy probability and chance of
  winning, from the decider's information. How a move of the bot's someone asks about is looked into.
- **`providence.ts`**: a benchmark of whether a network plays Providence where it should, against the reference
  search in `benchmarks/` (docs/BOT.md has Midstrike's score). Scoring a network takes seconds.

One-off investigations are in `../analysis` (and `training/analysis` for the Python ones).
