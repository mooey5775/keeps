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

  static let playkeeps = OnlineServer(
    name: "playkeeps.online", socket: URL(string: "wss://playkeeps.online/ws")!, site: URL(string: "https://playkeeps.online")!)

  /// The servers the app can play on: the website's. (A seat kept on midstrike.playkeeps.online, its old name, still
  /// comes back there: that name's WebSocket is served by the same server.) For tests, KEEPS_SERVER (a WebSocket
  /// address) is the one.
  static var known: [OnlineServer] {
    if let test = Internal.environment["KEEPS_SERVER"], let socket = URL(string: test) {
      return [OnlineServer(name: socket.host() ?? test, socket: socket, site: nil)]
    }
    return [.playkeeps]
  }
}
