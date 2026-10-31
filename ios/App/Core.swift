import Foundation
import WebKit

/// The app's core (ios/core): the game server the app plays on, with Midstrike, in a web view that is never shown
/// (WebKit's JIT runs the rules and the search; its network runs in Core ML, through the keeps:// scheme).
///
/// It speaks JSON strings both ways, as the generated types (Protocol.swift: FromApp in, ToApp out): messages go in
/// through keepsCore.receive(json) and come back through the `core` message handler. A connection is one client of
/// the core's server, speaking the website's protocol.
@MainActor
final class Core: NSObject, WKScriptMessageHandler {
  /// The web view: it must be in the window for its page to run at full speed (CoreView puts it there, unseen).
  let webView: WKWebView
  private var started: CheckedContinuation<ToAppReady, Error>?
  private var connections: [Int: (ToAppServer) -> Void] = [:]
  private var nextConnection = 1
  /// Each of Midstrike's searches, as it finishes.
  var onSearch: ((ToAppSearch) -> Void)?
  /// Something in the core failed (its message).
  var onFailure: ((String) -> Void)?

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
  }

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

  /// Sends a client message (the website's protocol) on connection `id`.
  func send(_ id: Int, _ message: ClientMessage) {
    deliver(.client(FromAppClient(id: Double(id), message: message)))
  }

  func close(_ id: Int) {
    deliver(.close(FromAppClose(id: Double(id))))
    connections[id] = nil
  }

  /// How long Midstrike waits before each move, so a person can follow it.
  func configure(botDelayMs: Int) {
    deliver(.config(FromAppConfig(botDelayMs: Double(botDelayMs))))
  }

  private func deliver(_ message: FromApp) {
    guard let data = try? JSONEncoder().encode(message), let json = String(data: data, encoding: .utf8) else {
      onFailure?("could not encode \(message)")
      return
    }
    webView.callAsyncJavaScript("keepsCore.receive(json)", arguments: ["json": json], in: nil, in: .page) { result in
      if case .failure(let error) = result { self.onFailure?("keepsCore.receive: \(error)") }
    }
  }

  nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let json = message.body as? String else { return }
    MainActor.assumeIsolated { self.received(json) }
  }

  /// Where the games' replays go (Documents/games, one file per game, rewritten after every move): they can be
  /// replayed or looked into later (`xcrun devicectl device copy from` fetches them).
  nonisolated static let gamesFolder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("games")
  private let writer = DispatchQueue(label: "keeps.games", qos: .utility)

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
    case .failed(let failed):
      if let started {
        started.resume(throwing: KeepsError("the core failed to start: \(failed.message)"))
        self.started = nil
      } else {
        onFailure?(failed.message)
      }
    case .server(let server):
      connections[Int(server.id)]?(server)
    case .search(let search):
      onSearch?(search)
    case .saved(let saved):
      keep(saved)
    }
  }
}
