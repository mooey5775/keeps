import Foundation
import WebKit

/// The app's core (ios/core): the game server the app plays on, with Midstrike, in a web view that is never shown
/// (WebKit's JIT runs the rules and the search; its network runs in Core ML, through the keeps:// scheme).
///
/// It speaks JSON strings both ways, as the generated types (Protocol.swift: FromApp in, ToApp out): messages go in
/// through keepsCore.receive(json) and come back through the `core` message handler. A connection is one client of
/// the core's server, speaking the website's protocol.
@MainActor
final class Core: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  /// The web view: it must be in the window for its page to run at full speed (CoreView puts it there, unseen).
  let webView: WKWebView
  private var started: CheckedContinuation<ToAppReady, Error>?
  private var connections: [Int: (ToAppServer) -> Void] = [:]
  private var nextConnection = 1
  /// Each of Midstrike's searches, as it finishes.
  var onSearch: ((ToAppSearch) -> Void)?
  /// Something in the core failed (its message).
  var onFailure: ((String) -> Void)?
  /// The core's process ended, and every room and connection with it: it's starting again (onRestarted follows).
  var onEnded: (() -> Void)?
  /// The core started again after its process ended (iOS ends a web view's process to free memory, mostly while the
  /// app is in the background): every room and connection went with it. Told once it's ready again.
  var onRestarted: (() -> Void)?
  /// The core's settings, sent again when it starts again.
  private var config: FromAppConfig?
  private var restarting = false
  /// For tests (KEEPS_LAG): the game server's messages are held this long, as on a slow phone (in order: each is held
  /// as long).
  var lag: TimeInterval = 0

  /// Throws if the network (Core ML) or the core's files aren't in `bundle`.
  init(bundle: Bundle = .main) throws {
    guard let root = bundle.url(forResource: "core", withExtension: nil) else { throw KeepsError("the core isn't in the app") }
    // The scheme handler goes in the configuration before the web view is made from it (the view takes a copy).
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(SchemeHandler(root: root, inference: try Inference()), forURLScheme: "keeps")
    webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
    super.init()
    // (The controller is shared with the view; a handler holds its target strongly: the core lives as long as the app.)
    config.userContentController.add(self, name: "core")
    webView.isInspectable = true
    webView.navigationDelegate = self
  }

  /// The page's process ended: the core loads again, and says when it's ready (onRestarted).
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    print("The core's process ended: starting it again")
    connections = [:]
    restarting = true
    onEnded?()
    webView.load(URLRequest(url: URL(string: "keeps://app/index.html")!))
  }

  #if DEBUG
  /// For tests (KEEPS_TEST_HOOKS): ends the core's process, as iOS might (WebKit's own, unpublished, way: in Debug
  /// builds only, which the UI tests run, so that no build sent to Apple names it).
  func endProcessForTest() {
    let end = NSSelectorFromString("_killWebContentProcess")
    guard webView.responds(to: end) else {
      onFailure?("WebKit can't end its process here")
      return
    }
    webView.perform(end)
  }
  #endif

  /// Loads the core and waits until it's ready: its network loaded, its search workers started. Returns what it said.
  func start() async throws -> ToAppReady {
    try await withCheckedThrowingContinuation { continuation in
      started = continuation
      webView.load(URLRequest(url: URL(string: "keeps://app/index.html")!))
    }
  }

  /// A new client of the core's server; its messages (each with the options and log lines) arrive at `receive`.
  /// Returns the connection's id.
  func connect(_ receive: @escaping (ToAppServer) -> Void) -> Int {
    let id = nextConnection
    nextConnection += 1
    connections[id] = receive
    deliver(.connect(FromAppConnect(id: Double(id))))
    return id
  }

  /// The game kept (Core.kept) taken up again, as a new client of the core's server in your seat; its messages arrive
  /// at `receive`. Returns the connection's id.
  func restore(_ kept: Kept, replay: String, _ receive: @escaping (ToAppServer) -> Void) -> Int {
    let id = nextConnection
    nextConnection += 1
    connections[id] = receive
    deliver(.restore(FromAppRestore(id: Double(id), game: kept.game, replay: replay)))
    return id
  }

  /// Sends a client message (the website's protocol) on connection `id` (if it's still there: it isn't, once the core's
  /// process has ended).
  func send(_ id: Int, _ message: ClientMessage) {
    guard connections[id] != nil else { return }
    deliver(.client(FromAppClient(id: Double(id), message: message)))
  }

  func close(_ id: Int) {
    guard connections[id] != nil else { return }
    deliver(.close(FromAppClose(id: Double(id))))
    connections[id] = nil
  }

  /// How long Midstrike waits before each move, so a person can follow it; and, for tests, a seed that makes every
  /// game the same.
  func configure(botDelayMs: Int, seed: String? = nil) {
    let config = FromAppConfig(botDelayMs: Double(botDelayMs), seed: seed)
    self.config = config
    deliver(.config(config))
  }

  /// KEEPS_TRACE: every message to and from the core printed, timed (how a game that stalls is looked into).
  private let trace = ProcessInfo.processInfo.environment["KEEPS_TRACE"] != nil

  private func traced(_ way: String, _ json: String) {
    guard trace else { return }
    print("\(Date().formatted(.iso8601.time(includingFractionalSeconds: true))) \(way) \(json.prefix(240))")
    fflush(stdout)
  }

  private func deliver(_ message: FromApp) {
    guard let data = try? JSONEncoder().encode(message), let json = String(data: data, encoding: .utf8) else {
      onFailure?("could not encode \(message)")
      return
    }
    traced("→", json)
    webView.callAsyncJavaScript("keepsCore.receive(json)", arguments: ["json": json], in: nil, in: .page) { result in
      if case .failure(let error) = result { self.onFailure?("keepsCore.receive: \(error)") }
    }
  }

  nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    // (WebKit delivers on the main thread; the message is the main actor's to read.)
    MainActor.assumeIsolated {
      guard let json = message.body as? String else { return }
      received(json)
    }
  }

  /// Where the games' replays go (Documents/games, one file per game, rewritten after every move): they can be
  /// replayed or looked into later (`xcrun devicectl device copy from` fetches them).
  nonisolated static let gamesFolder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("games")
  private let writer = DispatchQueue(label: "keeps.games", qos: .utility)

  /// The game in progress, kept as it's played (Documents/playing.json), to be taken up again should the app close:
  /// its replay's file (in gamesFolder) and what restoring it takes. Gone once the game is over, or left.
  struct Kept: Codable, Equatable {
    let file: String
    let game: GameRecord
  }

  nonisolated static let keptURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("playing.json")

  /// The game in progress the app kept, and its replay log; nil if there's none. One that can't be read is said so
  /// (onFailure), and dropped.
  func kept() -> (kept: Kept, replay: String)? {
    writer.sync {}  // (anything being written is written first)
    guard FileManager.default.fileExists(atPath: Core.keptURL.path) else { return nil }
    do {
      let kept = try JSONDecoder().decode(Kept.self, from: Data(contentsOf: Core.keptURL))
      return (kept, try String(contentsOf: Core.gamesFolder.appendingPathComponent(kept.file), encoding: .utf8))
    } catch {
      onFailure?("The game kept from last time couldn't be read (\(error)).")
      forgetKept()
      return nil
    }
  }

  /// No game in progress to take up again (it was left).
  func forgetKept() {
    writer.async { try? FileManager.default.removeItem(at: Core.keptURL) }
  }

  /// The most games kept (a game is some tens of kilobytes): when a new one starts, the oldest go.
  nonisolated static let gamesKept = 200

  private func keep(_ saved: ToAppSaved) {
    let url = Core.gamesFolder.appendingPathComponent((saved.file as NSString).lastPathComponent)
    writer.async {
      let files = FileManager.default
      do {
        try files.createDirectory(at: Core.gamesFolder, withIntermediateDirectories: true)
        let new = !files.fileExists(atPath: url.path)
        try Data(saved.text.utf8).write(to: url, options: .atomic)
        if new { Core.pruneGames() }
        // The game in progress, to take up again; over, nothing to take up.
        if !saved.game.over {
          try JSONEncoder().encode(Kept(file: url.lastPathComponent, game: saved.game)).write(to: Core.keptURL, options: .atomic)
        } else if let data = try? Data(contentsOf: Core.keptURL), (try? JSONDecoder().decode(Kept.self, from: data))?.file == url.lastPathComponent {
          try files.removeItem(at: Core.keptURL)
        }
      } catch {
        print("could not keep the game's replay \(url.lastPathComponent): \(error)")
      }
    }
  }

  /// Keeps the newest `gamesKept` games (by when they were last written).
  private nonisolated static func pruneGames() {
    let files = FileManager.default
    guard let urls = try? files.contentsOfDirectory(at: gamesFolder, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
    let dated = urls.map { url in (url, (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
    for (url, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(gamesKept) { try? files.removeItem(at: url) }
  }

  private func received(_ json: String) {
    traced("←", json)
    let message: ToApp
    do {
      message = try JSONDecoder().decode(ToApp.self, from: Data(json.utf8))
    } catch {
      onFailure?("unreadable message from the core (\(error)): \(json.prefix(300))")
      return
    }
    switch message {
    case .ready(let ready):
      started?.resume(returning: ready)
      started = nil
      if restarting {
        restarting = false
        if let config { deliver(.config(config)) }
        onRestarted?()
      }
    case .failed(let failed):
      if let started {
        started.resume(throwing: KeepsError("the core failed to start: \(failed.message)"))
        self.started = nil
      } else {
        onFailure?(failed.message)
      }
    case .server(let server):
      if lag > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + lag) { self.connections[Int(server.id)]?(server) }
      } else {
        connections[Int(server.id)]?(server)
      }
    case .search(let search):
      onSearch?(search)
    case .saved(let saved):
      keep(saved)
    }
  }
}
