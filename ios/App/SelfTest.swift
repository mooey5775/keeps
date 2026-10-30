import Foundation

/// Whole games against Midstrike with no one at the screen (KEEPS_SELFTEST=1 at launch): the app's player picks a random
/// legal move from the options the core sends with each game message, until the game is over. Every message must
/// decode (Protocol.swift), every move be accepted, the options must cover the legal moves, and Midstrike must search
/// at the level set. What it saw goes to stdout (ios/sync.sh streams it), ending with DONE.
@MainActor
final class SelfTest {
  private let core: Core

  init(core: Core) {
    self.core = core
  }

  /// One game per (level, marks to win).
  func run(_ games: [(level: BotLevel, marks: Int)]) async {
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
  private func play(level: BotLevel, marks: Int) async -> Int {
    var problems: [String] = []
    var counts: [String: Int] = [:]
    var searches: [(worlds: Int, ms: Int)] = []
    var myMoves = 0
    var answered = Set<String>()
    var settled = false
    var room = ""
    var result = ""
    let started = Date()
    var finish: CheckedContinuation<Void, Never>?
    var done = false
    let end = {
      guard !done else { return }
      done = true
      finish?.resume()
    }

    core.onSearch = { search in
      guard search.room == room, search.worlds > 0 else { return }
      searches.append((Int(search.worlds), Int(search.ms)))
    }
    core.onFailure = { problems.append("core: \($0)") }
    var id = 0
    id = core.connect { [core] server in
      counts[server.message.caseTag, default: 0] += 1
      switch server.message {
      case .error(let error):
        problems.append("error: \(error.message)")
      case .room(let message):
        guard !settled else { return }
        room = message.room.code
        let settings = message.room.settings
        if settings.botLevel != level || Int(settings.marksToWin) != marks {
          core.send(id, .settings(ClientMessageSettings(settings: Settings(marksToWin: Double(marks), firstPlayer: .random, botLevel: level))))
        } else {
          settled = true
          core.send(id, .start)
        }
      case .game(let game):
        let view = game.view
        if server.lines == nil { problems.append("a game message without log lines") }
        if view.phase == .gameOver {
          result = "marks \(view.marks.map { Int($0) })"
          return end()
        }
        let mine = view.prompts.compactMap { prompt -> PromptViewMine? in
          if case .mine(let p) = prompt { return p }
          return nil
        }
        // Tithes: any order of the pile is legal, so none is listed; answer with a shuffled one.
        for prompt in mine {
          if case .orderPile(let order) = prompt {
            guard answered.insert(order.id).inserted else { return }
            myMoves += 1
            core.send(id, .command(ClientMessageCommand(command: .answer(CommandAnswer(promptId: order.id, answer: .orderPile(AnswerOrderPile(order: order.cards.shuffled())))))))
            return
          }
        }
        let legal = view.legal
        guard !legal.isEmpty else { return }
        // Every legal move has its option, and nothing else is offered.
        let options = server.options ?? []
        if options.count != legal.count || !legal.allSatisfy({ c in options.contains { $0.command == c } }) {
          problems.append("options \(options.count) for \(legal.count) legal moves")
        }
        // One answer per decision (a prompt's id names it; between rounds, the round), however often it's sent.
        let between = legal.contains(.nextRound)
        guard !mine.isEmpty || between else { return }
        let decision = mine.isEmpty ? "next-round-\(Int(view.round))" : mine.map(\.id).joined(separator: ",")
        guard answered.insert(decision).inserted else { return }
        let choices = legal.filter { $0 != .revealDuplicity }
        myMoves += 1
        core.send(id, .command(ClientMessageCommand(command: (choices.isEmpty ? legal : choices).randomElement()!)))
      default:
        break
      }
    }
    core.send(id, .create(ClientMessageCreate(name: "Tester", bot: true)))
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
    let wanted = level == .hard ? 512 : level == .medium ? 64 : 0
    if level == .easy && !searches.isEmpty { problems.append("easy searched \(searches.count) times") }
    if level != .easy && searches.isEmpty { problems.append("\(level) never searched") }
    if let wrong = searches.first(where: { $0.worlds != wanted }) { problems.append("\(level) searched \(wrong.worlds) worlds, not \(wanted)") }
    let ms = searches.map(\.ms).sorted()
    say("\(level.rawValue), first to \(marks): \(result) in \(Int(seconds)) s; \(myMoves) moves of mine; Midstrike searched \(searches.count) times"
      + (ms.isEmpty ? "" : String(format: " (mean %.2f s, median %.2f s, max %.2f s)", Double(ms.reduce(0, +)) / Double(ms.count) / 1000, Double(ms[ms.count / 2]) / 1000, Double(ms.last!) / 1000))
      + "; messages \(counts.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", "))")
    for p in problems.prefix(10) { say("  PROBLEM \(p)") }
    return problems.count
  }
}
