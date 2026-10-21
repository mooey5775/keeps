# Keeps Engine Design

Status: draft for review (2026-10-20). Rules source of truth: [`rules/RULES.md`](../rules/RULES.md).

## Goals

1. **Enforce every rule**, including the official clarifications, with no "honor system" gaps.
2. **Deterministic and pure.** The same seed and the same commands always give the same game. There's no I/O, `Date`, or `Math.random` in the engine.
3. **Traceable.** Every state change emits a structured trace event, and every event records what caused it. A bug report is a replay file, and a replay file becomes a regression test.
4. **Shared.** The engine runs on the server (authoritative) and in the browser (puzzle mode, legal-move hints). It's a zero-dependency TypeScript package.
5. **Testable from any position.** Tests (and puzzles) can build an arbitrary mid-game state directly, without playing up to it.

## Package layout

```
packages/engine/
  src/
    cards/         one module per card: static data + effect handlers
    ops/           primitive operations (draw, moveCard, playCard, …)
    state.ts       GameState and related types
    engine.ts      apply(), advance(), legalCommands()
    triggers.ts    trigger collection and ordering
    scoring.ts
    view.ts        per-player redaction
    trace.ts       trace events + text formatter
    rng.ts         seeded PRNG (state stored in GameState)
    builders.ts    test/puzzle helpers to construct positions
  test/
    rules/  clarifications/  cards/  puzzles/  property/  replays/
```

TypeScript `strict`, `noUncheckedIndexedAccess`, and an `assertNever` helper on every switch over `CardId`, `Op`, `Command` and `TraceEvent`. Adding a card or op without handling it everywhere is a compile error.

## Core model

### Table and seats

- There are always **4 seats**, numbered 0–3 around the table. **Left of seat `s` is `(s + 1) % 4`**, which is also the play order.
- Each seat is a `player` or a `ghost`.
  - 2 players sit at opposite seats (0 and 2).
  - 3 players: the ghost seat is chosen at random.
- Ghosts have no hand, no keep and no actions, but **a pile still sits at their seat**. They're skipped in turn order and in tie-breaks, and can't receive Keep cards. They *can* be chosen for Legerdemain and Pickpocket, which does nothing because their hand is empty.

### Cards and zones

36 unique cards, `CardId` = a string-literal union (`'count-token' | 'acquisition' | …`). Static data per card:

```ts
interface CardDef {
  id: CardId; name: string; character: 'count' | 'fool' | 'friar';
  hot: boolean; keep: boolean;
  coins?: number | 'tithes';   // in HALF-coins (Royal Favor = 1, Chalice = 4, Blunder = -20)
  isCoinCard: boolean;          // Purity is false even though it scores
}
```

Coins are stored as integer **half-coins** to avoid floating point (Royal Favor is 0.5).

Every card is in exactly one zone at all times. This is the **card-conservation invariant**, checked after every op.

```ts
type Zone =
  | { kind: 'pile'; pileId: PileId; index: number }      // 0 = top
  | { kind: 'hand'; seat: Seat }
  | { kind: 'keep'; seat: Seat; faceDown?: true }          // faceDown only via Duplicity
  | { kind: 'discard'; index: number }
  | { kind: 'limbo'; reason: 'resolving' | 'looking' };    // card mid-play or being looked at
```

### Piles

```ts
interface Pile {
  id: PileId;                         // stable identity: 'count' | 'fool' | 'friar' | 'mask' (server-only knowledge)
  cards: { id: CardId; faceUp: boolean }[];   // [0] is the top
}
pileAt: [PileId, PileId, PileId, PileId];     // which pile sits at which seat
```

- **"Your pile"** = `pileAt[yourSeat]`. Piles move with Juggling (swap), Pandemonium (rotate) and Fiat (re-claim). Cards never move between piles except through those effects, Blunder placement, and Tithes reordering.
- **Revelation** flips a pile: reverse `cards` and toggle every card's `faceUp`. The top card of a face-up stack is public. This one model also covers Blunder placed **face-up** on top of a pile.
- **Pile identity is hidden from everyone.** No view contains a `PileId`. Clients get stable opaque labels per seat position.

### Game state (abridged)

```ts
interface GameState {
  config: { seats: SeatKind[]; marksToWin: number };
  rng: RngState;
  round: number; marks: Record<Seat, number>;
  piles: Record<PileId, Pile>; pileAt: PileId[];
  hands: Record<Seat, CardId[]>;
  keeps: Record<Seat, KeepCard[]>;          // KeepCard = { id, faceDown?: { placedBy: Seat } }
  discard: CardId[];
  turn: { seat: Seat; usedOncePerTurn: CardId[]; actionsTaken: number } | null;
  stack: Op[];                              // resolution stack: see below
  prompts: Prompt[];                        // open decisions; non-empty ⇒ engine is waiting
  roundEnd: null | { kind: 'empty-pile'; enderSeat: Seat } | { kind: 'tokens'; winner: Seat };
  phase: 'lobby' | 'playing' | 'post-round' | 'scoring' | 'game-over';
  knowledge: Record<Seat, KnownFact[]>;     // private info each player has seen (for views/log)
  history: Snapshot[];                      // undo stack for the current round
  traceSeq: number;
}
```

## The resolution stack

Every rule is implemented as **ops** on one stack. That covers turns, actions, card effects, triggers, prompts and windows. The engine loop (`advance`):

```
while prompts is empty:
  if a token victory is present → end round (tokens); clear stack
  if stack is empty → start next turn (or score, if the round has ended)
  op = stack.pop(); run handler(op)    // handlers may push ops, open prompts, emit trace events
check invariants
```

Ops are **plain serializable data**. There are no closures or generators. This means:

- The full mid-resolution state can be snapshotted (undo), sent to a debugger, or built by tests.
- A multi-step effect is a chain of ops: Legerdemain → `ChoosePlayer` → `StealRandom` → `PlayAsHot` → … Each op that needs input opens a `Prompt`. The answer to the prompt pushes the next op.

### Op types (initial set)

| Op | Meaning |
|----|---------|
| `ActionFrame{seat, remaining, kind, restricted}` | Grants actions. `kind`: `turn` / `hocus-pocus` / `retribution` / `last-laugh`. While it's on top with `remaining > 0`, the seat is prompted for an action. |
| `Draw{seat, pile, cause}` | Draw the top card of a pile into a hand. **Drawing from an empty pile ends the round.** |
| `Play{seat, card, asHot, target?}` | Move the card out of the hand, resolve its effect, then `AfterPlay`. |
| `AfterPlay{playId}` | Open a Duplicity window if needed, then collect and push triggers for this play. |
| `Effect{card, step, data}` | One step of a card's effect, e.g. `{card:'prayer', step:'take-or-discard'}`. |
| `Trigger{kind, seat, playId}` | Retribution, Interest or Royal Favor resolving. |
| `HotCheck{seat}` | Play any HOT card now in the seat's hand. |
| `Window{holder, reason}` | Duplicity reveal opportunity (see below). |
| `LastLaugh` / `Score` | Post-round sequence. |

### Turns and actions

- At turn start, the engine pushes `ActionFrame{kind:'turn', remaining: 2}`, or `remaining: 1` if **Shackles** is face-up in the player's keep at that moment.
- **Action commands** (each costs 1 unless noted):
  - Draw from your pile.
  - Play a non-HOT card from your hand.
  - Use a keep ability:
    - Acquisition, Juggling, Sanction: once per turn, own turn only.
    - Shackles: discard it from your own keep.
    - Tithes: discard all coin cards, then reorder your pile.
    - Blunder: **2 actions**, place it face-up on any pile.
- **Hocus Pocus** (or Joker copying it) costs 1 action and pushes `ActionFrame{kind:'hocus-pocus', remaining:2}`. That frame inherits its parent frame's restrictions.
- **Restricted frames** (`retribution`, `last-laugh`, and any Hocus Pocus frame inside them) can't use Acquisition, Sanction or Juggling.
- **Once-per-turn** abilities are tracked by card id in `turn.usedOncePerTurn` and reset at turn start. They're usable only when the actor is the turn player and the top frame's chain leads back to that player's `turn` frame.
- **Blunder's 2-action cost** may span any **contiguous same-seat frames** on the stack, with no other ops between them. Examples: the last action of a Hocus Pocus frame plus the next action of the turn frame, or both Retribution actions.
- A turn ends when its `turn` frame and everything above it have resolved. Play passes left, skipping ghosts.
- You **must** take your actions; there's no pass command. A legal action always exists, because drawing from an empty pile is legal (it ends the round).

### HOT cards

- Whenever a card enters a hand **by any means** (draw, Sanction, Acquisition, Requisition, Epiphany, Prayer, Resurrection, Pluck, Offering, Pickpocket), the engine pushes `HotCheck`.
- A HOT card in hand is played immediately at no action cost. Keep cards go into any player's keep (Blunder only into your own); non-Keep cards resolve.
- **Multiple draws resolve one at a time.** Acquisition draws left, resolves any HOT card fully, then draws right, so later draws see the board as earlier HOT cards changed it.
- "Play it as if it were HOT!" (Legerdemain, Invocation) = `Play{asHot:true}`: no action cost, played immediately.

### Card plays

- **Keep cards** go face-up into any *player's* keep (not ghosts). Blunder must go into your own.
- **Non-Keep cards** go to the discard **first**, then their effect resolves. That's why Resurrection can resurrect itself, and Joker can fetch Joker.
- **Joker:** reveal a non-Keep card from your hand, which stays in your hand. Joker goes to the discard and resolves that card's effect as its own.

### Triggers

Triggers are **collected per play** and pushed in `AfterPlay`, after the play's whole effect (including Legerdemain's stolen card) has resolved:

1. **Retribution:** for each seat P ≠ actor that had Retribution face-up in its keep *at the start or end* of the play, and whose hand or keep changed during the play. Pushes `ActionFrame{kind:'retribution', remaining:2}`. **At most once per play per seat.** Covers "swapped out by Providence still triggers" and "Duplicity or its face-down card, not both".
2. **Interest:** for each Coin card that entered keep K during the play, where Interest was face-up in K *before that card entered* and Interest itself didn't arrive in the same swap. K's owner draws from their pile.
3. **Royal Favor:** each time Royal Favor entered a keep during the play, that keep's owner draws from their pile.

The batch is pushed so that it pops in clarification order: **Legerdemain's HOT card (already resolved inside the play) → Retribution → Interest → Royal Favor**, and in occurrence order within a kind.

**Resolution is depth-first.** Triggers caused while resolving a trigger (e.g. Interest draws Blunder → Blunder enters keep → Interest again) resolve before the remaining siblings. This matches the Royal Favor 3 puzzle's narration. It's my interpretation (flagged below).

Keep cards only enter keeps through plays (direct, HOT, or Providence swaps), so "per play" covers every keep entry.

### Duplicity

- Playing Duplicity also places a Keep card from your hand **face-down** into any keep. That card has no effect, no coin value, and isn't a Coin card for Interest or Pickpocket. It **does** count as a card for Tithes, and it can't be discarded by Tithes' action.
- **Reveal** is a free command for whoever currently has Duplicity face-up in their keep (`state.keeps`). It's processed whenever the engine is waiting for input, even after round end and after Last Laugh. Revealing never triggers Interest or Retribution by itself.
- **The problem:** the engine resolves chains automatically, so "any time" has no natural pause in the middle of a chain. The clarifications rely on reveals mid-chain (Interest, Retribution).
- **The solution: reveal windows.** `AfterPlay` pushes `Window{holder}` before triggers whenever a face-down card exists and the play
  - (a) moved a Coin card into the keep holding the face-down card, or
  - (b) changed the hand or keep of that keep's owner (actor ≠ owner).

  It also opens a window at round end (before Last Laugh and again before scoring). The holder answers reveal or pass. If revealed, trigger collection treats the card as having been face-up for this play. That's how "Interest can be revealed as soon as a coin card enters" and "Retribution can be revealed as soon as the card is played" work.
- **The conditions use only public information**, so a window opening never leaks what the face-down card is. Clients may offer an auto-pass toggle; the engine doesn't care.
- **Shackles reveal mid-turn:** no window is needed, since the turn player's second action is already a pause. If Shackles is revealed in the turn player's keep after they've taken ≥ 1 action, their `turn` frame's `remaining` is set to 0.
- **Token victory** requires all three tokens face-up; revealing the last one wins instantly.

### Round end

- **Drawing from an empty pile** (by any means: own draw, Interest, Royal Favor, Prayer, Sanction, Invocation, Acquisition) ends the round.
  - Set `roundEnd = {kind:'empty-pile', enderSeat}`, clear the stack, and drop open prompts.
  - Then push: `Window` (Duplicity) → `LastLaugh` (if Last Laugh is face-up in a keep; its owner gets `ActionFrame{kind:'last-laugh', remaining:1}`) → `Window` → `Score`.
  - After round end, more draws from empty piles are no-ops (legal, logged).
  - Last Laugh's action, and anything it triggers (Hocus Pocus, Retribution, Interest, Tithes), resolve normally.
- **Token victory:** checked after **every** op. If one keep holds all three tokens face-up, `roundEnd = {kind:'tokens'}`, clear everything, and that player gets the mark. No Last Laugh, Retribution or scoring. This applies even during post-round.
- **Scoring** (half-coins):
  - Sum the face-up Coin cards. Tithes = 2 × (number of cards in that keep, including face-down cards and itself).
  - Purity adds 20 if the rest of the keep sums to exactly 0.
  - The highest score wins. **Tie:** walk left from `enderSeat` (`ender+1, ender+2, …`), skipping ghosts, and the first tied player wins. The ender is checked last, so the ender loses ties.
- The winner gets a mark and starts the next round. First to `marksToWin` (default 3) wins the game.

## Commands and prompts

Everything a client sends is a `Command`. The engine validates each one against `legalCommands(state, seat)`.

```ts
type Command =
  | { type: 'answer'; promptId: string; choice: Choice }   // every in-game decision, including choosing an action
  | { type: 'reveal-duplicity' }
  | { type: 'propose-undo' } | { type: 'vote-undo'; accept: boolean };
```

- Choosing an action is a prompt too: `{kind:'action', seat, options:[…]}`. Effects open prompts like `choose-player`, `choose-pile`, `choose-keep-card-pair`, `choose-card-from(list)`, `order-cards`, `choose-direction`, `reveal-or-pass`.
- Several prompts can be open at once: **Offering** asks every other player to give a card at the same time.
- Prompts carry ids, so stale answers are rejected.
- `legalCommands` is the single source of truth for the UI (highlighting) and for random-play tests.

Public API:

```ts
newGame(config, seed): GameState
apply(state, seat, command): { state: GameState; events: TraceEvent[] } | { error: EngineError }
legalCommands(state, seat): Command[]
viewFor(state, seat | 'spectator'): PlayerView
```

`apply` never mutates its input. It works on a `structuredClone`, which is cheap for 36 cards.

## Traces

Every op emits **TraceEvents**:

```ts
interface TraceEvent {
  seq: number; round: number;
  depth: number;                 // stack depth → indentation
  cause: number | null;          // seq of the event that caused this one
  type: 'turn-start' | 'action' | 'draw' | 'play' | 'effect' | 'move' | 'pile-move' | 'pile-flip'
      | 'trigger' | 'prompt' | 'answer' | 'window' | 'reveal' | 'round-end' | 'score' | 'mark'
      | 'undo' | 'invariant-check' | …;
  data: Record<string, unknown>;
  visibility: 'all' | Seat[];    // who may see the full event
  redacted?: TraceEventData;     // what everyone else sees (e.g. "P2 drew a card")
}
```

- **Readable formatter** (used in test failures and the dev CLI):

  ```
  #41  R2 T7  P1 action 1/2: play Royal Favor → keep(P3)                [cause #40]
  #42           move royal-favor hand(P1) → keep(P3)
  #43           after-play: collect triggers → [interest(P3), royal-favor(P3)]
  #44           trigger interest(P3): draw from pile@P3 (2 cards)
  #45             draw blunder → hand(P3)  ⚠ HOT
  #46             play blunder (HOT) → keep(P3)
  #47             after-play: collect triggers → [interest(P3)]
  #48             trigger interest(P3): draw from pile@P3 (0 cards)
  #49             ROUND END — ender P3 (drew from empty pile)
  #50           (cleared 1 pending op: trigger royal-favor(P3))
  ```

- **Cause chains:** `cause` links let a test or debugger ask why something happened, e.g. "this draw ← Interest ← Royal Favor play ← Resurrection".
- **Player logs:** the in-game log for each player is the trace filtered through `visibility`/`redacted`. That's the same data, so the log can't drift from the engine.
- **Replays:** the server writes one JSONL file per room: config, seed, and every command with its seat. `pnpm engine replay <file>` re-runs it and prints the formatted trace.
  - **Bug workflow:** grab the replay file → add it to `test/replays/` with an assertion → fix.
- **Trace assertions:** test helpers like `expectTrace(events).toContainInOrder([{type:'trigger', data:{kind:'retribution'}}, {type:'trigger', data:{kind:'interest'}}])`. Full-trace snapshots are kept for puzzles only, where they act as golden files.

## Views and hidden information

`viewFor(state, seat)` builds what a player may see:

- **Visible to everyone:**
  - Pile sizes, the top card if face-up, and an opaque label for each pile position.
  - All keeps, with face-down cards shown as "face-down card".
  - The discard pile.
  - Hand counts, marks, whose turn it is, open prompts (who is being waited on, and what kind of prompt).
- **Only to that player:**
  - Their own hand.
  - Prompt options addressed to them.
  - Cards they're currently looking at (Requisition, Epiphany, Prayer, Pluck, Tithes reorder).
  - Their `knowledge` log, e.g. which card they placed face-down with Duplicity.
- **Never sent to anyone:** pile identities, the order of face-down pile cards, other hands, the RNG state.

A property test serializes every view at every step of random games and checks that no card id appears that the player isn't entitled to see.

## Undo ("propose undo")

- Before each accepted `answer` command, the engine pushes a snapshot of the state onto `history`. History covers the current round and is cleared when a new round starts.
- `propose-undo` asks every other real player for approval. If all accept, the state is restored to the snapshot before the most recent command. Repeat to step further back.
- The RNG state is part of the snapshot, so redoing the same command gives the same random result. Legerdemain can't be re-rolled.
- **Known leak:** info a player already saw (e.g. Requisition) can't be unseen. That's acceptable for friends.

## Rulings and open questions

These are defaults the engine will implement unless you overrule them. Each one gets a test named for its ruling, so changing a ruling means changing a test on purpose.

| # | Question | Default |
|---|----------|---------|
| Q1 | **Fiat** is printed HOT + Keep, but its text has no keep trigger. | The effect happens on play. Fiat then sits in the keep with no effect. |
| Q2 | Trigger resolution when a trigger causes more triggers. | Depth-first (new triggers resolve before remaining siblings). |
| Q3 | Blunder's "any two consecutive actions". | Contiguous same-seat frames on the stack; not across turns. |
| Q4 | Can the **Duplicity holder** (if different from the placer) look at the face-down card? | No. Only the placer knows it; the holder reveals blind. |
| Q5 | Can **Providence** swap a face-down card? | Yes, and it stays face-down. |
| Q6 | Does revealing a face-down **Royal Favor** count as "entering" the keep? | No (consistent with "revealing doesn't trigger Interest/Retribution"). |
| Q7 | **Shackles revealed** mid-turn while Hocus Pocus actions remain. | Only the `turn` frame is zeroed; already-granted Hocus Pocus actions remain. |
| Q8 | **Acquisition:** "pile to your left/right" after a HOT draw moved piles (e.g. Pandemonium). | Evaluated at the time of each draw. |
| Q9 | **Joker** with no non-Keep card in hand. | Can't be played from hand. Played as HOT (Legerdemain/Invocation) with none: no effect, discarded. |
| Q10 | **Revelation** on an already-flipped pile. | Flips it back. |
| Q11 | **Legerdemain/Pickpocket** on yourself. | Legal. Legerdemain plays a random card from your own hand; Pickpocket is a no-op. |
| Q12 | First player of the first round ("the wisest player"). | The host picks, or random. |
| Q13 | Does **Retribution** trigger from non-play changes (keep abilities like Juggling or Tithes)? | No: the card says "plays a card". |
| Q14 | Royal Favor entering a keep via a **Providence swap**. | Triggers ("enters your keep"). |

## Test plan

Vitest + fast-check. Test files live by category. **Every test name includes its spec id**, so coverage is greppable.

### Spec manifest and coverage meta-test

`test/spec-manifest.ts` lists every rule (R-*), clarification (C-*), ruling (Q-*), pinned card behavior (K-*) and puzzle (P-*), with the quoted source text. The meta-test `test/spec-coverage.test.ts` looks for a test whose name starts with each id:

- While the engine is being built, uncovered ids show as **todo**, so `pnpm test` stays green and real failures stay visible.
- `pnpm test:strict` (and CI) turns every uncovered id into a **failure**. **Every clarification must be tested.**
- A test name that uses an id missing from the manifest always fails (catches typos).

### Rules card (R-*)

| Id | Rule |
|----|------|
| R-01 | Setup: 3 character piles of 12; top 3 of each make the Mask; 4 piles of 9; random positions |
| R-02 | Fewer than 4 players → ghost seats keep piles; 2 players sit opposite |
| R-03 | Exactly two actions per turn (draw from your pile or play from hand); no passing |
| R-04 | First player = last round's winner; play continues left, skipping ghosts |
| R-05 | HOT cards cost no action and must be played the instant they enter a hand (every entry path) |
| R-06 | Keep cards go into any player's keep (not ghosts); non-Keep cards are discarded face up |
| R-07 | Drawing from an empty pile ends the round (every draw path) |
| R-08 | Most coins wins; tie → tied player most directly left of the ender; the ender loses ties |
| R-09 | Victory marks; first to 3 (configurable) wins the game |
| R-10 | Public info: pile sizes, keep cards, discard, hand counts (view tests) |

### Clarifications (C-*), one or more tests each

| Id | Clarification | Test sketch |
|----|---------------|-------------|
| C-01 | Simultaneous triggers: Legerdemain HOT → Retribution → Interest → Royal Favor | Royal Favor played into a keep with Interest + Retribution; assert trace order. Separate case with Legerdemain stealing from that player. |
| C-02 | After round end, no actions except Last Laugh and what it triggers | Pending triggers cleared at round end; Last Laugh's Interest draw still happens |
| C-03 | Duplicity can reveal after round end, before or after Last Laugh | Reveal at both windows |
| C-04 | Tokens completed after round end = token victory; only that player marks | Last Laugh action plays the third token |
| C-05 | Any number of empty-pile draws after round end is legal | Draw ×2 during Last Laugh + Hocus Pocus; no errors, no state change |
| C-06 | 2 players sit at opposite piles | Seat assignment test |
| C-07 | Acquisition not usable with Retribution / Last Laugh actions | `legalCommands` excludes it in those frames (and in Hocus Pocus frames nested inside them) |
| C-08 | Blunder: any two consecutive actions | Hocus Pocus last action + turn action; both Retribution actions; rejected across turns |
| C-09 | Tokens: instant, total round end; no Last Laugh / Retribution; mark; next round | Third token entering a Retribution owner's keep: no Retribution frame |
| C-10 | Tokens with Duplicity must all be face-up | Face-down token: no win; reveal → win |
| C-11 | Duplicity reveal costs no action, any time, even after Last Laugh | Action count unchanged; reveal accepted in post-round |
| C-12 | Last Laugh face-down can be revealed at the end for its action | Round end window → reveal → last-laugh frame |
| C-13 | Retribution face-down revealed as the triggering card is played → 2 actions | Window from public condition (b) |
| C-14 | Shackles revealed after the first action ends the turn | Turn frame zeroed; next player's turn |
| C-15 | Interest face-down revealed when a coin enters → forced draw | Window from public condition (a) |
| C-16 | Duplicity play: it or the face-down card can trigger Retribution, not both; reveal doesn't trigger | Both into a Retribution keep → one frame |
| C-17 | Placing or revealing a face-down card never triggers Interest | Face-down coin card into an Interest keep → no draw |
| C-18 | Tithes counts the face-down card; Tithes' discard never removes it | Scoring + ability test |
| C-19 | Fiat: only real players claim piles | 3-player Fiat; ghost gets the leftover |
| C-20 | Fiat in 2 players: player who played Fiat places the remaining two piles | Prompt sequence |
| C-21 | Providence swapping Interest with a Coin card doesn't trigger Interest | Also: a coin swapped *into* a keep with Interest **does** trigger (Tokens 3 puzzle) |
| C-22 | Last Laugh doesn't trigger on token victory | — |
| C-23 | Acquisition / Sanction / Juggling not usable with Last Laugh's action | `legalCommands` |
| C-24 | Duplicity: Last Laugh revealed after game end; face-down revealed after Last Laugh action | Sequence test |
| C-25 | Legerdemain may target yourself; the card is still random | Seeded RNG; card chosen ≠ a player choice |
| C-26 | Legerdemain may target ghosts | No-op, discards Legerdemain |
| C-27 | Legerdemain from a Retribution owner: stolen card played first; double trigger = 4 actions if the stolen card also affects them | Steal Offering from the Retribution owner |
| C-28 | Pickpocket may target ghosts | No-op |
| C-29 | Providence can swap two cards in the same keep | — |
| C-30 | Providence swapping Retribution out still triggers it for the original owner | — |
| C-31 | Purity active when other coins net 0 (Dagger + two Tokens) | Scoring |
| C-32 | Resurrection can resurrect Resurrection | Discard-first ordering |
| C-33 | Retribution actions can't use Acquisition / Sanction / Juggling | `legalCommands` |
| C-34 | Sanction not usable with Retribution / Last Laugh actions | `legalCommands` |
| C-35 | Juggling not usable with Retribution / Last Laugh actions | `legalCommands` |
| C-36 | Tithes' discard also discards Tithes | — |

### Pinned card behaviors (K-*)

Specific behaviors you asked to have tested explicitly, beyond the clarifications.

| Id | Behavior |
|----|----------|
| K-01 | Invocation: the card it draws is played as if HOT!, so that play uses no action. Invocation is itself HOT!, so the whole chain is free (Resurrection 3 puzzle: Invocation reached through Joker → Resurrection invokes Hocus Pocus without spending an action). |
| K-02 | Legerdemain: the stolen card is played as if HOT!, using no action beyond the one spent on Legerdemain. |

### Per-card tests (`test/cards/`)

Each of the 36 cards gets at least: the basic effect, edge targets (empty piles, empty hands, ghosts, self), interaction with HOT, and traces. That's on top of the C-* tests.

### Puzzles (P-*)

- The 25 official puzzles from `rules/PUZZLES.md`. Each one: build the position with `builders.ts`, apply the official solution as commands, and assert the round winner plus a golden trace snapshot.
- Positions still have to be transcribed from the puzzle page images (to do when we implement).
- These same fixtures power puzzle mode in the UI.

### Property / fuzz tests (`test/property/`)

Random games where every seat picks random `legalCommands`, thousands of seeds, 2/3/4 players. After every command, check:

- **Card conservation:** all 36 cards, each in exactly one zone.
- **No HOT card in any hand** while the engine waits for input.
- **No deadlock:** while the game isn't over, some seat has a legal command.
- **Determinism:** re-running seed + commands gives an identical state and trace.
- **Undo round-trip:** `apply` then undo restores a deep-equal state.
- **View redaction:** no hidden card id in any serialized view.
- **Pure scoring:** `score(state)` is the same before and after a no-op clone.
- **Trace integrity:** every `cause` points to an earlier `seq`.

A failing seed is shrunk by fast-check and saved to `test/replays/`.

## Build order

1. `state.ts`, `rng.ts`, card data, `builders.ts`, invariant checker, trace + formatter.
2. Core loop: turns, draw, play keep/non-keep, HOT, round end, scoring, ties, marks (R-* tests).
3. Simple cards (coins, tokens, Requisition, Epiphany, Prayer, Resurrection, Providence, Pandemonium, Juggling, Sanction, Revelation, Hocus Pocus, Shackles, Purity, Tithes).
4. Triggers: Interest, Royal Favor, Retribution, plus ordering and depth-first resolution.
5. Interaction-heavy cards: Legerdemain, Invocation, Joker, Pluck, Pickpocket, Offering, Acquisition, Fiat, Blunder, Last Laugh.
6. Duplicity and windows.
7. Views, undo, property tests, puzzle fixtures, replay CLI.
