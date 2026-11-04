# Keeps roadmap

Status, 2026-11-03. The game is live at https://playkeeps.online: one Fly machine, one server, with Midstrike to play
against, and an iOS app (games against Midstrike on the phone, and online play on the website's server).

**This is the one list of what's next:** plans, to-dos and open bugs, for the website, the app and Midstrike. The
detail lives next to the code, linked from here: [BOT.md](BOT.md) for Midstrike, [ios/README.md](../ios/README.md) for
the app, [ENGINE.md](ENGINE.md) and [rules/](../rules/) for the rules. Those keep no to-do lists of their own.

## Direction

From a long talk with David Buffkin, Keeps' co-creator (2026-11-03):

- **Agreed:** sign-in with an Elo-like rating, and playkeeps.online eventually merging with keepsgame.com.
- **The game log goes.** Remembering what was played is much of the game's skill, and a full log makes it too easy.
  Both apps get no log, only a ticker of the latest moves that fades, as at a real table. Online, players talk
  wherever they already do; integrated chat comes later, with open online play.
- **Help is opt-in instead:** an assistance mode (below).
- **Every move is animated,** the opponents' too: seeing it only in a log takes away from the game's elegance. It
  should feel native, not like an old Flash game.
- **Later:** statistics for each player (which cards help most, which they play well or badly against the best play),
  and chess.com-style puzzles.

## Do next

1. **The rules corrections, the new art and a retraining of Midstrike, together.** Not startable piecemeal: each
   rule change alters what the network was trained on, so they go in one run, then one deploy of the website and the
   app together.
   - **Fiat is not a Keep card** (David, 2026-11-03): HOT, and discarded after its effect. Our engine and
     [rules/RULES.md](../rules/RULES.md) have it as HOT and Keep, from a preview card.
   - **Tithes no longer reorders your pile:** its action discards all Coin cards in your keep, nothing more (the same
     preview). The reorder screen, its hint and the bot's card-by-card reorder search all go.
   - **The new card art:** high-resolution, borderless pictures of all 36 cards from David, the same size and names as
     `cards/` (a drop-in replacement). Kept at `~/keeps-archive/card-art-2026-11-03/Borderless.zip`. Ships with the
     rules change: the new Tithes card has the new text.
   - **Epiphany and Prayer on a face-up pile** show everyone the card under the one picked up (the open bug below).
   - **The belief's two known gaps** (a pile seen, then taken from unseen; "just taken" across a Duplicity reveal):
     [BOT.md, Known limitations](BOT.md#known-limitations).
   - Then: the clarifications and engine tests for each, the protocol version raised, the network retrained and held to
     the Providence benchmark, the website and the app deployed together.
2. **Ship the phone's search fix** (`da43f88`: a search's chunks are the same work whatever the decision; Konwoo's
   "Midstrike is crashing", 2026-11-03, on a 46-option Providence choice). Confirmed on Konwoo's phone (build 236).
   Left: the full iOS suite, and your phone. If that decision is too slow on a phone (it's about 11× a usual one),
   consider capping the work for decisions with many options.
3. **Move Midstrike's search off gpu03,** which isn't ours to rely on. The search is bound by the CPU (the game engine
   and the world sampler: 97% of its time), not the network, so no GPU is needed. The plan:
   - measure 512 worlds (the phone's Hard) against 2,048 (the website's), to see if the website can search less;
   - a 16-CPU search machine on Fly, started when a game against Midstrike begins and suspended when idle, running the
     gpu03 worker's code unchanged over Fly's private network;
   - profile the engine and the world sampler (a phone core runs them several times faster than a laptop's).
   This also lets the website's machine suspend: today the worker's constant polling keeps it running around the clock.

## The game, on the website and in the app

- **No game log; a fading ticker of the latest moves** (Direction, above). The website shows the whole log beside the
  table, and the app has a Log sheet: both go. Rule disputes and round reviews keep their own record of the game.
- **Duplicity's reveal, in a time window.** Revealing is allowed at any time (C-11), so today the engine asks the
  Duplicity holder at every reveal window, which is tedious online. David's proposal: when it isn't the holder's
  action next, a short window in which they may reveal, then play goes on; the same as a minimum delay between the
  other player's moves while a hidden Duplicity card is out (which everyone can see). Mostly the room and the tables;
  the engine's windows can stay. Check what it means for Midstrike (it reveals only at its own decisions and the
  windows, [BOT.md](BOT.md)) and for C-14's Shackles trick.
- **Animations for every move,** including Midstrike's and other players': cards moving from hand to keep, piles
  pushed and claimed, swaps. Native-feeling: SwiftUI's own transitions in the app; short, eased transitions on the
  website.
- **Assistance mode** (opt-in):
  - what you know for certain about each pile: the cards you've seen and where they still are (the facts in the
    belief Midstrike's network is given, only where they're sure);
  - "are you sure?" before a move that sets off something on another player, such as their Retribution;
  - training mode's hints and the round reviews may belong here too.
  - Open: are assisted games rated? (Probably not.)
- **Online room polish:** who's connected while playing, a spectator's table.
- **The wide layout** (iPad, the iPhone Duo unfolded, and a Mac version through Catalyst): the table only has the
  phone's narrow layout. The Duo simulator works now.
- **An archive and a review of any game:** step through a finished game move by move from any player's view (the
  engine's trace and `eventsFor`), with Midstrike's review for any game, not only those against it.
- **The website's games survive restarts:** the server keeps each room's replay log and restores it at start-up
  (`Room.restore`, which the app already uses), so a deploy stops ending games, and the rule to deploy only when the
  site is idle can go.

## Accounts, ratings and statistics

David is on board with sign-in and ratings, and with merging into keepsgame.com.

- **Sign-in:** Discord or Google, no passwords to store. Playing as a guest stays as it is.
- **Profiles:** name, game history, win rate and the like.
- **Ratings:**
  - **OpenSkill** (an open-source relative of TrueSkill) rather than Elo, because it rates finishing positions in
    multiplayer games.
  - **Separate ratings per player count:** two-, three- and four-player Keeps play very differently.
  - **Rated games use fixed settings,** such as first to 3 marks and a random first player. Casual games keep every
    option.
  - **Finishing order:** by marks, ties broken by the last round's coins. Leaving a game counts as losing it; a game
    the host ends early isn't rated.
- **Leaderboards:** among friends first. Matchmaking only once enough people play.
- **Integrity:** in 3–4 player games, two players can quietly team up against a third. Rate 2-player games first,
  look for patterns, or rely on friends playing fair.
- **Statistics:** which cards help most, and for each player which cards they play well or badly against Midstrike's
  best play (the round reviews already judge every decision).
- **Puzzles,** chess.com-style: the official ones ([rules/PUZZLES.md](../rules/PUZZLES.md)), and positions from real
  games where one move wins (the reviews find them).
- **Chat,** with open online play.

## Midstrike

- **Long combos are a blind spot** ([BOT.md](BOT.md#open-problems)). The search tries each move, then plays the
  rest with the network, which rarely starts a combo of several moves on its own (URTB, 2026-11-02: Resurrection,
  Requisition, Invocation, Pluck, which it rated at 0% by instinct). So Midstrike neither finds them nor fears them,
  and the round review, which judges with the same playouts, calls such a winning combo "a mistake that worked out".
  Fixes: search a turn's whole sequence, or a network that plays them; meanwhile, read verdicts on long combos with
  care.
- **Providence is sometimes missed,** and the [benchmark](BOT.md#open-problems) holds the next network to it.
- **Three and four players,** and bots in place of ghosts: the network plays heads-up only.
- **Count the sampler's give-ups and the bot's fallbacks in production,** somewhere that lasts (Fly's logs last
  minutes).
- **The analysis tools on the batched path** (most search on the CPU; `searchat.ts` and `providence.ts` can use a
  network server).

## The iOS app

- **Measure the round reviews on a real phone** (half the website's sample sizes): how long a round takes, and the
  battery.
- **The test suite's time:** about 7½ minutes, of which the tests take 4; the rest is building the app.
- **iOS 26:** Konwoo's phone runs it; everything has been tested on iOS 27 only.
- **Before the App Store:**
  - the privacy manifest (`PrivacyInfo.xcprivacy`: UserDefaults is a required-reason API) and the App Store's privacy
    labels: the install id, game statistics (only if shared), and what a report sends (its text, the contact given, a
    screenshot, the game). No tracking prompt: none of it is joined with other companies' data or used for ads;
  - TestFlight;
  - David & Elaina's go-ahead for the app with their art.
- **Waiting on the developer account:**
  - room links open the app (Universal Links): `applinks:playkeeps.online` in the app's Associated Domains, the server
    serving `/.well-known/apple-app-site-association` for `/r/*`, and the app joining the room it's given; a
    long-press still opens the page in Safari, so the website stays playable;
  - your-turn notifications for online games, through Apple's push service.

## Open bugs

- **Epiphany and Prayer on a face-up pile hide the card underneath** (rules dispute, Konwoo, 2026-10-25). Both say
  "**pick up** and look at the top card": on a pile Revelation turned face up, picking up the top card shows everyone
  the face-up card beneath it while the player decides. The engine leaves the cards on their piles until the choice
  (`effects.ts`: `epiphany`, the `prayer` branch), so that card stays hidden. Fix: reveal the card under each
  picked-up face-up top to everyone, as a public event, with the cards left in place (the bot's belief already
  handles a seen card at a known pile position). Also: a card taken into a hand from a face-up top (Epiphany, Prayer,
  Requisition) is logged hidden although everyone saw it (`takeIntoHand`). Part of the retraining in Do next.
- **Disputes are kept only in analytics.** Append every dispute to a file on the data volume too.

## Done

- **Persistence:** every game's replay log on a Fly volume; a room with a game in progress waits 3 days for its
  players; the app keeps its game and takes it up again after it closes.
- **Midstrike** (Phase 1 and 3 of the old plan, done early): a network trained by self-play (VRPO) with search over
  sampled worlds on top, Easy to Hard, on the website and on the phone's Neural Engine; training mode; round reviews.
- **The iOS app:** offline games against Midstrike, online play, round reviews, settings, licences.
