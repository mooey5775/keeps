import Foundation

/// Whole games against Midstrike with no one at the screen (KEEPS_SELFTEST=1 at launch): the app's player picks a random
/// legal move from the options the core sends with each game message, until the game is over. Every message must be
/// well formed, every move accepted, the options must cover the legal moves, and Midstrike must search at the level
/// set. What it saw goes to stdout (ios/sync.sh streams it), ending with DONE.
@MainActor
final class SelfTest {
  private let core: Core

  init(core: Core) {
    self.core = core
  }

  /// One game per (level, marks to win).
  func run(_ games: [(level: String, marks: Int)]) async {
    say("self-test: \(games.count) game(s)")
    var failures = 0
    for (level, marks) in games {
      failures += await play(level: level, marks: marks)
    }
    say(failures == 0 ? "PASSED" : "FAILED: \(failures) problem(s)")
    say("DONE")
  }

  private func say(_ line: String) {
    print(line)
    fflush(stdout)
  }

  /// Plays one game; returns how many problems it found.
  private func play(level: String, marks: Int) async -> Int {
    var problems: [String] = []
    var counts: [String: Int] = [:]
    var searches: [(worlds: Int, ms: Int)] = []
    var myMoves = 0
    var answered = Set<String>()
    var settled = false
    var room = ""
    let started = Date()
    var finish: CheckedContinuation<Void, Never>?
    var done = false
    var result = ""

    core.onSearch = { m in
      guard (m["room"] as? String) == room, let worlds = m["worlds"] as? Int, worlds > 0 else { return }
      searches.append((worlds, m["ms"] as? Int ?? 0))
    }
    core.onFailure = { problems.append("core: \($0)") }
    var id = 0
    let end = {
      guard !done else { return }
      done = true
      finish?.resume()
    }
    id = core.connect { [core] envelope in
      guard let message = envelope["message"] as? [String: Any], let t = message["t"] as? String else {
        problems.append("a message without a type: \(envelope)")
        return
      }
      counts[t, default: 0] += 1
      switch t {
      case "error":
        problems.append("error: \(message["message"] ?? "?")")
      case "room":
        guard !settled, let summary = message["room"] as? [String: Any] else { return }
        room = summary["code"] as? String ?? ""
        let settings = summary["settings"] as? [String: Any] ?? [:]
        if settings["botLevel"] as? String != level || settings["marksToWin"] as? Int != marks {
          core.send(id, ["t": "settings", "settings": ["marksToWin": marks, "firstPlayer": "random", "botLevel": level]])
        } else {
          settled = true
          core.send(id, ["t": "start"])
        }
      case "game":
        guard let view = message["view"] as? [String: Any] else { return problems.append("a game message without a view") }
        let legal = view["legal"] as? [[String: Any]] ?? []
        let options = envelope["options"] as? [[String: Any]] ?? []
        if envelope["lines"] == nil { problems.append("a game message without log lines") }
        if view["phase"] as? String == "game-over" {
          let marksNow = view["marks"] as? [Int] ?? []
          result = "marks \(marksNow)"
          return end()
        }
        let prompts = (view["prompts"] as? [[String: Any]] ?? []).filter { $0["mine"] as? Bool == true }
        // Tithes: any order of the pile is legal, so none is listed; answer with a shuffled one.
        if let order = prompts.first(where: { $0["kind"] as? String == "order-pile" }), let promptId = order["id"] as? String {
          guard answered.insert(promptId).inserted else { return }
          let cards = (order["cards"] as? [String] ?? []).shuffled()
          myMoves += 1
          core.send(id, ["t": "command", "command": ["type": "answer", "promptId": promptId, "answer": ["kind": "order-pile", "order": cards]]])
          return
        }
        guard !legal.isEmpty else { return }
        // Every legal move has its option (and nothing else is offered).
        let key = { (c: Any) -> String in
          let data = (try? JSONSerialization.data(withJSONObject: c, options: .sortedKeys)) ?? Data()
          return String(decoding: data, as: UTF8.self)
        }
        let offered = Set(options.compactMap { $0["command"] }.map(key))
        if offered != Set(legal.map(key)) { problems.append("options \(offered.count) for \(legal.count) legal moves") }
        // One answer per decision (a prompt's id names it; between rounds, the round), however often it's sent.
        let between = legal.contains { $0["type"] as? String == "next-round" }
        guard !prompts.isEmpty || between else { return }
        let decision = prompts.isEmpty ? "next-round-\(view["round"] ?? 0)" : prompts.compactMap { $0["id"] as? String }.joined(separator: ",")
        guard answered.insert(decision).inserted else { return }
        let choices = legal.filter { $0["type"] as? String != "reveal-duplicity" }
        myMoves += 1
        core.send(id, ["t": "command", "command": (choices.isEmpty ? legal : choices).randomElement()!])
      default:
        break
      }
    }
    core.send(id, ["t": "create", "name": "Tester", "bot": true])
    await withCheckedContinuation { continuation in
      finish = continuation
      Task {
        try? await Task.sleep(for: .seconds(1800))
        problems.append("the game didn't end within 30 minutes")
        end()
      }
    }
    core.close(id)
    let seconds = Date().timeIntervalSince(started)
    let wanted = level == "hard" ? 512 : level == "medium" ? 64 : 0
    if level == "easy" && !searches.isEmpty { problems.append("easy searched \(searches.count) times") }
    if level != "easy" && searches.isEmpty { problems.append("\(level) never searched") }
    if let wrong = searches.first(where: { $0.worlds != wanted }) { problems.append("\(level) searched \(wrong.worlds) worlds, not \(wanted)") }
    let ms = searches.map(\.ms).sorted()
    say("\(level), first to \(marks): \(result) in \(Int(seconds)) s; \(myMoves) moves of mine; Midstrike searched \(searches.count) times"
      + (ms.isEmpty ? "" : String(format: " (mean %.2f s, median %.2f s, max %.2f s)", Double(ms.reduce(0, +)) / Double(ms.count) / 1000, Double(ms[ms.count / 2]) / 1000, Double(ms.last!) / 1000))
      + "; messages \(counts.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", "))")
    for p in problems.prefix(10) { say("  PROBLEM \(p)") }
    return problems.count
  }
}
