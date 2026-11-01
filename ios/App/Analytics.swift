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
  /// When the project's key was last asked for (offline, at most once a minute, not once an event).
  private var askedAt = Date.distantPast
  /// Events not sent yet (no project key yet, or the network away): the latest few hundred, kept in a file, so games
  /// played offline are counted once the phone is back online, even if the app was closed meanwhile.
  private var queue: [[String: Any]] = []
  private static let queueMax = 300
  private static let queueFile = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("analytics-queue.json")

  private init() {
    if let id = UserDefaults.standard.string(forKey: Self.installKey) {
      installId = id
    } else {
      installId = UUID().uuidString.lowercased()
      UserDefaults.standard.set(installId, forKey: Self.installKey)
    }
    queue = (try? Data(contentsOf: Self.queueFile)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
  }

  /// The events waiting, written down (or the file removed, with none).
  private func keep() {
    if queue.isEmpty {
      try? FileManager.default.removeItem(at: Self.queueFile)
      return
    }
    try? FileManager.default.createDirectory(at: Self.queueFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let data = try? JSONSerialization.data(withJSONObject: queue) { try? data.write(to: Self.queueFile, options: .atomic) }
  }

  /// Sharing turned off: what's waiting is never sent.
  func stopSharing() {
    queue = []
    keep()
  }

  /// Sends what's waiting, if the person shares (the app calls it as it starts: events kept from an offline game).
  func flush() {
    guard sharing else { return stopSharing() }
    send()
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
    keep()
    send()
  }

  private func send() {
    guard sharing else { return stopSharing() }
    guard !queue.isEmpty else { return }
    guard let project else { return findProject() }
    let batch = queue
    queue = []
    keep()
    var request = URLRequest(url: project.host.appendingPathComponent("batch/"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["api_key": project.key, "batch": batch])
    URLSession.shared.dataTask(with: request) { _, response, error in
      let sent = error == nil && ((response as? HTTPURLResponse)?.statusCode ?? 0) < 300
      // (Not sent: kept, to go with the next; unless sharing was turned off meanwhile.)
      if !sent {
        Task { @MainActor in
          guard self.sharing else { return }
          self.queue.insert(contentsOf: batch.suffix(max(0, Self.queueMax - self.queue.count)), at: 0)
          self.keep()
        }
      }
    }.resume()
  }

  /// The website's PostHog project (key and host), from its config.json.
  private func findProject() {
    guard !fetching, Date.now.timeIntervalSince(askedAt) > 60, let site = OnlineServer.playkeeps.site else { return }
    fetching = true
    askedAt = .now
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
