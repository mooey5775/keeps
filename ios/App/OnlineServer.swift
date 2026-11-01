import Foundation

/// A game server elsewhere, where the app plays online: the website's, spoken to as a browser speaks to it.
struct OnlineServer: Codable, Equatable, Hashable, Identifiable {
  /// What the app calls it (its host).
  let name: String
  /// Its WebSocket address.
  let socket: URL
  /// Its website, where a browser joins a room (`/r/CODE`).
  let site: URL?

  var id: URL { socket }

  /// The link that invites someone to room `code`, in a browser.
  func invite(_ code: String) -> URL? { site?.appendingPathComponent("r").appendingPathComponent(code) }

  static let midstrike = OnlineServer(
    name: "midstrike.playkeeps.online", socket: URL(string: "wss://midstrike.playkeeps.online/ws")!, site: URL(string: "https://midstrike.playkeeps.online")!)

  /// The servers the app can play on: Midstrike's site, which speaks the app's protocol (playkeeps.online will, once
  /// it's updated to this branch's: its rooms don't yet say whether they have the bot). For tests, KEEPS_SERVER (a
  /// WebSocket address) is the one.
  static var known: [OnlineServer] {
    if let test = ProcessInfo.processInfo.environment["KEEPS_SERVER"], let socket = URL(string: test) {
      return [OnlineServer(name: socket.host() ?? test, socket: socket, site: nil)]
    }
    return [.midstrike]
  }
}
