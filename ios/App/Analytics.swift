import Foundation

/// The app's analytics. An install id, made once and anonymous, is what the website's server knows the app by (sent as
/// `client` online, as a browser sends its own), so its online games count as a browser's do. The games played on the
/// phone are counted only if the person chooses to share them (`sharing`, off until they turn it on): their events,
/// the same as the website's server sends for its games, go to PostHog, whose project key the website gives
/// (config.json; it's public, as every browser has it).
@MainActor
final class Analytics {
  static let shared = Analytics()
  static let sharingKey = "shareGamesOnThePhone"
  private static let installKey = "installId"

  /// This install's id.
  let installId: String
  /// Whether the person shares their games on the phone.
  var sharing: Bool { UserDefaults.standard.bool(forKey: Self.sharingKey) }

  private var project: (key: String, host: URL)?
  private var fetching = false
  /// Events not sent yet (no project key yet, or the network away): the latest few hundred.
  private var queue: [[String: Any]] = []
  private static let queueMax = 300

  private init() {
    if let id = UserDefaults.standard.string(forKey: Self.installKey) {
      installId = id
    } else {
      installId = UUID().uuidString.lowercased()
      UserDefaults.standard.set(installId, forKey: Self.installKey)
    }
  }

  /// An event of a game on the phone, from the core: sent on if the person shares their games.
  func record(_ event: ToAppAnalytics) {
    guard sharing else { return }
    var properties = (try? JSONSerialization.jsonObject(with: Data(event.properties.utf8))) as? [String: Any] ?? [:]
    // Not who you are: the phone's random id only, no name (the game's own names of its players aside: player_names),
    // and no place (no lookup of the address it's sent from).
    for name in ["player_names", "player_ips", "scores", "marks"] where properties[name] != nil { properties[name] = nil }
    if let winner = properties["winner"] as? String, winner != "Midstrike" { properties["winner"] = "you" }
    properties["distinct_id"] = event.client
    properties["$geoip_disable"] = true
    properties["$ip"] = NSNull()
    properties["platform"] = "ios"
    properties["on_the_phone"] = true
    properties["app_version"] = AppInfo.version
    queue.append(["event": event.event, "properties": properties, "timestamp": ISO8601DateFormatter().string(from: .now)])
    if queue.count > Self.queueMax { queue.removeFirst(queue.count - Self.queueMax) }
    send()
  }

  private func send() {
    guard !queue.isEmpty else { return }
    guard let project else { return findProject() }
    let batch = queue
    queue = []
    var request = URLRequest(url: project.host.appendingPathComponent("batch/"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["api_key": project.key, "batch": batch])
    URLSession.shared.dataTask(with: request) { _, response, error in
      let sent = error == nil && ((response as? HTTPURLResponse)?.statusCode ?? 0) < 300
      // (Not sent: kept, to go with the next.)
      if !sent { Task { @MainActor in self.queue.insert(contentsOf: batch.suffix(Self.queueMax - self.queue.count), at: 0) } }
    }.resume()
  }

  /// The website's PostHog project (key and host), from its config.json.
  private func findProject() {
    guard !fetching, let site = OnlineServer.playkeeps.site else { return }
    fetching = true
    URLSession.shared.dataTask(with: site.appendingPathComponent("config.json")) { data, _, _ in
      let config = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      Task { @MainActor in
        self.fetching = false
        guard let key = config?["posthogKey"] as? String else { return }
        let host = (config?["posthogHost"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://us.i.posthog.com")!
        self.project = (key, host)
        self.send()
      }
    }.resume()
  }
}

/// The app's version and build, and the device it's on (for reports and analytics).
enum AppInfo {
  static var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }
  static var build: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?" }
  /// The device's model identifier ("iPhone17,1").
  static var device: String {
    var info = utsname()
    uname(&info)
    return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
  }
}
