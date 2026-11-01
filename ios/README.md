# Keeps for iOS

The game against Midstrike, offline, on the phone.

- **The UI** is SwiftUI (`App/`).
- **The core** (`core/`, bundled by `sync.sh`) is the website's TypeScript running in a hidden WKWebView: the engine, the game server, Midstrike's host and its search in Web Workers. WebKit's JIT is what makes the search fast enough.
- **The network** runs in Core ML on the Neural Engine, served to the core through the `keeps://` scheme (`Shared/SchemeHandler.swift`, `Shared/Inference.swift`).
- **Swift talks to the core** in the website's own protocol, with Swift types generated from the TypeScript ones (`Shared/Protocol.swift`, from `tools/swift-types/generate.ts`).
- **No rules or wording in Swift.** With each game message the core sends what the web client works out: the options (every legal move, with the table elements it involves, and how it's dragged), the log's lines and the table's words. Choosing by touch is `web/src/game/options.ts`'s logic, in `Shared/Choosing.swift`, held to it by `ChoosingTests`.

## Building, testing, looking

All of it runs from this machine. The Mac builds over ssh. `MAC=` is its address: Tailscale by default, or `edwardli@10.16.19.95` on the local network.

- `ios/sync.sh` builds the app, installs it on the phone and runs it.
  - Add `--no-run` to only install it.
  - Use `APP_ID=online.playkeeps.KeepsSpike` until the developer account has a profile for the app's own id.
- `SIM='iPhone 17' ios/sync.sh --no-run` builds for the Mac's simulator instead (no signing).
- `ios/tools/screenshot.sh out.png 20 KEEPS_PLAY=easy:3:12` takes a screenshot on the simulator: a game against Easy, with your first 12 moves made at random.
- `GOLDENS_HOST=gpu03 ios/test.sh` runs the tests (on this tree's core, built by `ios/tools/build-core.sh`, as `sync.sh`'s is):
  - the generated types checked against the TypeScript;
  - the golden messages of whole games, recorded on gpu03;
  - the Swift tests on the simulator: the protocol round trips, choosing, and the table's UI tests (touching, holding, carrying).
- `KEEPS_SELFTEST=1 ios/sync.sh` plays whole games headless on the phone or simulator.
- `KEEPS_SEED=ui-7` at launch makes every game the same, for the UI tests: the deal, the seating, Midstrike's draws.
  The UI tests use `ui-7` (your first cards played on their own) and `ui-keep-3` (your first card a Keep card).
- `KEEPS_LAG=2000` holds the game's messages 2 s, as on a slow phone (a move touched twice in that time is made once).
- `KEEPS_CONTINUE=3` goes straight into the kept game (`Documents/playing.json`) and makes your next 3 moves at random;
  `KEEPS_TRACE=1` prints every message between the app and the core, timed (and keeps the phone awake). On the phone:
  `xcrun devicectl device process launch --console --environment-variables '{"KEEPS_CONTINUE":"3","KEEPS_TRACE":"1"}'`.
  How a game that froze on the phone was looked into: its kept game copied back onto the phone, and played on.
- `xcrun simctl io booted recordVideo` while a UI test runs, then `ffmpeg` frames tiled into a sheet: how cards flying
  to their places were checked frame by frame (one card, no ghost).
- `ios/tools/pull-games.sh` fetches the games the app kept: each one's replay log, in `Documents/games`.
- `python3 ios/tools/make-icon.py` draws the icon.

## A game kept through the app closing

The core sends each game's replay after every move (`saved`), with what taking it up again takes: the room's code, its
start, its settings, who sits where. The app keeps both (`Documents/games`, and `Documents/playing.json` for the game in
progress). Opened again, the lobby offers to continue it: the core rebuilds its room (`Room.restore`, the server's own),
every move replayed as it was played, so Midstrike and training mode know what they knew, and the app resumes its seat.
When iOS ends the core's process (it may, in the background, to free memory), the core starts again and the game is
taken up the same way.

## TODO

- **Next:** joining games on playkeeps.online (the core opening a WebSocket to the website's server, its messages through
  the same bridge).
- **Analytics:** collect game traces (each game's replay log, already kept on the phone and on the website's server),
  opt-in on the app, sent to a server of ours or PostHog (the website already uses it).
  With it, **shake to report a bug**: a sheet for what happened, sent with a screenshot taken at the shake, the game's
  replay and the app's version (also in the table's menu: a shake can't be found, and UI tests can't shake).

- **The round review** (the website's end-of-round review, with each move's win chance and better moves). The core already makes it; the app doesn't show it yet. It should run on the phone at a reduced budget: reuse Midstrike's live searches, use smaller samples, at low priority.
- **Before the App Store:** confirm that HamletOrNot (the heading font, "freeware") may be shipped in an app.
