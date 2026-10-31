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
- `GOLDENS_HOST=gpu03 ios/test.sh` runs the tests:
  - the generated types checked against the TypeScript;
  - the golden messages of whole games, recorded on gpu03;
  - the Swift tests on the simulator: the protocol round trips, choosing, and the table's UI tests (touching, holding, carrying).
- `KEEPS_SELFTEST=1 ios/sync.sh` plays whole games headless on the phone or simulator.
- `KEEPS_SEED=ui-7` at launch makes every game the same, for the UI tests: the deal, the seating, Midstrike's draws.
- `ios/tools/pull-games.sh` fetches the games the app kept: each one's replay log, in `Documents/games`.
- `python3 ios/tools/make-icon.py` draws the icon.

## TODO

- **Next:** keeping a game through the app closing (rebuilt from its kept replay) and the app's lifecycle; joining games on
  playkeeps.online (the core opening a WebSocket to the website's server, its messages through the same bridge).
- **Analytics:** collect game traces (each game's replay log, already kept on the phone and on the website's server),
  opt-in on the app, sent to a server of ours or PostHog (the website already uses it).

- **The round review** (the website's end-of-round review, with each move's win chance and better moves). The core already makes it; the app doesn't show it yet. It should run on the phone at a reduced budget: reuse Midstrike's live searches, use smaller samples, at low priority.
- **A ghost on letting go of a carried card.** A copy flies off the screen as the card glides to its place. Record it on the simulator, frame by frame, to find which view it is.
- **Before the App Store:** confirm that HamletOrNot (the heading font, "freeware") may be shipped in an app.
