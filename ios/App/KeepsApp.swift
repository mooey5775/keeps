import SwiftUI
import WebKit

/// Keeps: the card game, offline against Midstrike.
@main
struct KeepsApp: App {
  @State private var core: Core?
  @State private var game: Game?
  @State private var status = "Starting…"

  init() {
    Theme.registerFonts()
  }

  var body: some Scene {
    WindowGroup {
      Group {
        if let game {
          RootView(game: game)
        } else {
          Splash(status: status)
        }
      }
      .preferredColorScheme(.dark)
      // The core's web view, in the window but unseen: a page that isn't in one runs slowly, or not at all.
      .background {
        if let core { CoreView(core: core).frame(width: 1, height: 1).opacity(0.01) }
      }
      .task { await start() }
    }
  }

  private func start() async {
    do {
      let core = try Core()
      self.core = core
      let ready = try await core.start()
      print("Core ready: \(ready.network), \(Int(ready.workers)) search workers")
      fflush(stdout)
      let environment = Internal.environment
      if environment["KEEPS_SELFTEST"] != nil {
        UIApplication.shared.isIdleTimerDisabled = true
        let games = (environment["KEEPS_SELFTEST_GAMES"] ?? "hard:1,easy:1").split(separator: ",").map { spec in
          let parts = spec.split(separator: ":")
          return (level: BotLevel(rawValue: String(parts[0])) ?? .hard, marks: Int(parts.count > 1 ? parts[1] : "1") ?? 1)
        }
        core.configure(botDelayMs: 0)
        status = "Self-test running…"
        await SelfTest(core: core).run(games)
        status = "Self-test done"
        return
      }
      // KEEPS_SEED (for tests): every game dealt the same.
      if let seed = environment["KEEPS_SEED"] { core.configure(botDelayMs: 900, seed: seed) }
      // KEEPS_LAG=300 (for tests): the game's messages arrive 300 ms late, as on a slow phone.
      if let lag = environment["KEEPS_LAG"].flatMap(Double.init) { core.lag = lag / 1000 }
      let game = Game(core: core, book: CardBook(ready.cards))
      self.game = game
      // KEEPS_PLAY=easy:3[:12]: straight into a game (for screenshots and trying the table), your first 12 moves at random.
      if let play = environment["KEEPS_PLAY"] {
        let parts = play.split(separator: ":").map(String.init)
        game.play(
          Game.Setup(level: BotLevel(rawValue: parts[0]) ?? .easy, marks: parts.count > 1 ? Int(parts[1]) ?? 3 : 3, first: .you),
          autoplay: parts.count > 2 ? Int(parts[2]) ?? 0 : 0)
      }
      // KEEPS_CONTINUE[=n]: straight into the kept game, if there is one, and your next n moves at random.
      if let moves = environment["KEEPS_CONTINUE"], game.unfinished != nil { game.resume(autoplay: Int(moves) ?? 0) }
      // (A traced run is watched from the Mac: the phone stays awake for it.)
      if environment["KEEPS_TRACE"] != nil { UIApplication.shared.isIdleTimerDisabled = true }
    } catch {
      status = "The core failed: \(error)"
      print("FAILED: \(error)\nDONE")
      fflush(stdout)
    }
  }
}

/// The lobby, the wait while a game is set up, or the table.
struct RootView: View {
  @Bindable var game: Game

  var body: some View {
    Group {
      switch game.screen {
      case .lobby: LobbyView(game: game)
      case .starting: Splash(status: game.starting)
      case .room: RoomView(game: game)
      case .table: TableView(game: game)
      }
    }
    // The card being held, shown over everything: the table, and any sheet over it.
    .background(PreviewWindow(game: game))
    .alert("Something went wrong", isPresented: Binding(get: { game.problem != nil }, set: { if !$0 { game.problem = nil } })) {
      Button("OK") { game.problem = nil }
    } message: {
      Text(game.problem ?? "")
    }
  }
}

struct Splash: View {
  let status: String

  var body: some View {
    ZStack {
      Theme.background.ignoresSafeArea()
      VStack(spacing: 12) {
        Text("KEEPS").font(Theme.heading(64, relativeTo: .largeTitle)).foregroundStyle(Theme.goldBright)
        Text(status).font(Theme.text(.callout)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
      }
      .padding()
    }
  }
}

/// The core's web view, placed in the window (it's never meant to be seen).
struct CoreView: UIViewRepresentable {
  let core: Core

  func makeUIView(context: Context) -> WKWebView { core.webView }
  func updateUIView(_ view: WKWebView, context: Context) {}
}
