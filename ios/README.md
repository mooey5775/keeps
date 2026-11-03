# Keeps for iOS

Keeps on the phone: games against Midstrike, offline, and online play on the website's server.

- **The UI** is SwiftUI (`App/`).
- **The core** (`core/`, the workspace package `@keeps/ios-core`, bundled by `sync.sh`) is the website's TypeScript running in a hidden WKWebView: the engine, the game server, Midstrike's host and its search in Web Workers. WebKit's JIT is what makes the search fast enough.
- **The network** runs in Core ML on the Neural Engine, served to the core through the `keeps://` scheme (`Shared/SchemeHandler.swift`, `Shared/Inference.swift`).
- **Swift talks to the core** in the website's own protocol, with Swift types generated from the TypeScript ones (`Shared/Protocol.swift`, from `tools/swift-types/generate.ts`).
- **No rules or wording in Swift.** With each game message the core sends what the web client works out: the options (every legal move, with the table elements it involves, and how it's dragged), the log's lines and the table's words. Choosing by touch is `packages/table/src/options.ts`'s logic, in `Shared/Choosing.swift`, held to it by `ChoosingTests`.

## Building, testing, looking

All of it runs from this machine. The Mac builds over ssh. The scripts take the Mac's address (`MAC=user@host`), the
phone's id (`DEVICE=`, from `xcrun devicectl list devices`) and the bundle id to build as (`APP_ID=`) from the
environment or from `ios/local.env` (not committed), a shell file that sets them:

```
MAC=${MAC:-me@my-mac.local}
DEVICE=${DEVICE:-00008150-...}
APP_ID=${APP_ID:-online.playkeeps.KeepsSpike}   # until the developer account has a profile for the app's own id
```

- `ios/sync.sh` builds the app, installs it on the phone and runs it.
  - Add `--no-run` to only install it.
- `SIM='iPhone 17' ios/sync.sh --no-run` builds for the Mac's simulator instead (no signing).
- `ios/tools/screenshot.sh out.png 20 KEEPS_PLAY=easy:3:12` takes a screenshot on the simulator: a game against Easy, with your first 12 moves made at random.
- `GOLDENS_HOST=gpu03 ios/test.sh` runs the tests (on this tree's core, built by `ios/tools/build-core.sh`, as `sync.sh`'s is):
  - the generated types checked against the TypeScript;
  - the golden messages of whole games, recorded on gpu03;
  - the Swift tests on the simulator: the protocol round trips, choosing, and the table's UI tests (touching, holding, carrying).
- The `KEEPS_*` switches below, and the core's web view open to Safari's Web Inspector, are in our own builds only
  (`App/Internal.swift`): Debug (the tests') and `sync.sh`'s. `STORE=1 ios/sync.sh` builds as the App Store would
  have it, without them. A build's number is the commit count (`sync.sh`); its version, `MARKETING_VERSION` in
  `project.yml`.
- `KEEPS_SELFTEST=1 ios/sync.sh` plays whole games headless on the phone or simulator.
- `KEEPS_SEED=ui-7` at launch makes every game the same, for the UI tests: the deal, the seating, Midstrike's draws.
  The UI tests use `ui-7` (your first cards played on their own) and `ui-keep-3` (your first card a Keep card).
- `KEEPS_BOT_DELAY=150` makes Midstrike wait 150 ms before each move instead of 900 (the UI tests use it).
- `KEEPS_LAG=2000` holds the game's messages 2 s, as on a slow phone (a move touched twice in that time is made once).
- `KEEPS_CONTINUE=3` goes straight into the kept game (`Documents/playing.json`) and makes your next 3 moves at random;
  `KEEPS_TRACE=1` prints every message between the app and the core, timed (and keeps the phone awake). On the phone:
  `xcrun devicectl device process launch --console --environment-variables '{"KEEPS_CONTINUE":"3","KEEPS_TRACE":"1"}'`.
  How a game that froze on the phone was looked into: its kept game copied back onto the phone, and played on.
- `xcrun simctl io booted recordVideo` while a UI test runs, then `ffmpeg` frames tiled into a sheet: how cards flying
  to their places were checked frame by frame (one card, no ghost).
- `ios/tools/pull-games.sh` fetches the games the app kept: each one's replay log, in `Documents/games`.
- The icon is an Icon Composer document, `App/AppIcon.icon` (Liquid Glass: the system draws its light, dark, tinted and
  clear looks from its layers). Open it in Icon Composer (in Xcode) to change it; `ictool AppIcon.icon --export-image`
  (in Icon Composer's Executables) renders a look without opening it.

## A game kept through the app closing

The core sends each game's replay after every move (`saved`), with what taking it up again takes: the room's code, its
start, its settings, who sits where. The app keeps both (`Documents/games`, and `Documents/playing.json` for the game in
progress). Opened again, the lobby offers to continue it: the core rebuilds its room (`Room.restore`, the server's own),
every move replayed as it was played, so Midstrike and training mode know what they knew, and the app resumes its seat.
When iOS ends the core's process (it may, in the background, to free memory), the core starts again and the game is
taken up the same way.

## Analytics and reports

- **Online,** the app sends an install id (made once, anonymous) as its `client`, as a browser does, so the website's
  server counts its games as it counts a browser's.
- **On the phone,** games are counted only if the person turns on "Share my games on this phone" in Settings (off
  until then). The core sends the app the same events the website's server sends (its local server's tracker), and
  the app passes them to PostHog with the website's public project key (`config.json`), under the phone's random id:
  no names (the players', the winner's) and no location. `App/Analytics.swift`.
- **Shake to report** (or "Report a problem" in the menus): a sheet for what happened, sent to the website's
  `/dispute` with the app's version and device, a screenshot taken as the report began (the server keeps it, behind
  the admin password), and the game: the online room's seat, or the phone's game's replay. `App/Report.swift`.

## Playing online

The lobby's Online side makes a room on the website's server, or joins one by its code. The core opens a WebSocket
there (`core/remote.ts`) and passes the server's messages through the same bridge, with the same options and words
as a game on the phone; a connection that drops comes back by itself and takes its seat again (`resume`, with the
seat's token, as a browser's tab does). The app keeps that seat, so after it closes the lobby offers to go back.

- **Which server:** playkeeps.online. Its old name for the bot, midstrike.playkeeps.online, is the same server: its
  pages go to playkeeps.online, its WebSocket (an app built for it, a seat kept there) is still served.
- **Versions:** the server's welcome carries its `PROTOCOL` (packages/protocol); the core stops at one that speaks
  another and says which side is behind, rather than meet messages the app can't read. Bump it only for a change an
  older app can't read; make new fields optional instead where possible.
- **Tests:** `ios/core/test/remote.test.ts` plays through the bridge on the website's server, run in Node
  (`pnpm -C ios/core test`, and with every package's: `pnpm test`); the UI tests play on `ios/tools/test-server.ts`,
  which `test.sh` runs here and forwards to the Mac (`KEEPS_SERVER=ws://localhost:7777/ws`).

## TODO

- **Next:** the online room's polish (who's connected while playing, a spectator's table).

- **Your-turn notifications**, online: a push when it's your move and the app is closed (the server sends it through
  Apple's push service; waits for the developer account).
- **Room links open the app** (Universal Links): `applinks:playkeeps.online` in the app's Associated Domains, the
  server serving `/.well-known/apple-app-site-association` for `/r/*`, and the app joining the room it's given; a
  long-press still opens the page in Safari, so the website stays playable. Needs the paid developer account.
- **The round review on the phone** uses half the website's sample sizes (`scaledSizes(0.5)` in `core/main.ts`): watch
  how long a round's review takes on a real phone, and its battery, before going further either way.
- **Before the App Store:**
  - confirm that HamletOrNot (the heading font, "freeware") may be shipped in an app;
  - the privacy manifest (`PrivacyInfo.xcprivacy`: UserDefaults is a required-reason API) and the App Store's privacy
    labels: the install id, game statistics (only if shared), and what a report sends (its text, the contact given,
    a screenshot, the game). No tracking prompt (App Tracking Transparency): none of it is joined with other
    companies' data or used for ads.
