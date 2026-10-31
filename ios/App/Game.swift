import Foundation
import Observation
import SwiftUI

/// A game against Midstrike, as the app holds it: one connection to the core's server (the website's protocol), the
/// room it made, and the game's latest message with what the core worked out for it (the options, the log's lines,
/// the table's words). The views read it and call it; it never decides a rule.
@MainActor
@Observable
final class Game {
  /// How to start: Midstrike's level, the marks to win, who plays first.
  struct Setup: Equatable {
    /// Your name, as the log writes it ("Eddie draws a card…"; the table says "you").
    var name = "Player"
    var level: BotLevel = .hard
    var marks = 3
    var first: First = .random

    enum First: String, CaseIterable, Identifiable {
      case random = "Random", you = "You", midstrike = "Midstrike"
      var id: String { rawValue }
    }
  }

  let core: Core
  let book: CardBook
  /// Where the app is: choosing a game, setting it up with the core, or at the table.
  private(set) var screen: Screen = .lobby
  enum Screen { case lobby, starting, table }

  private(set) var room: RoomSummary?
  private(set) var game: ServerMessageGame?
  private(set) var options: [Option] = []
  private(set) var lines: [LogLine] = []
  private(set) var table: TableText?
  /// The table elements touched so far for the move being made.
  private(set) var picked: [String] = []
  /// The card being dragged, if one is.
  private(set) var dragging: Drag?
  /// A card let go where it makes a move, waiting there for the move's position (it glides from there to its place).
  private(set) var landing: Drag?
  /// Moves you've made, and moves of Midstrike's seen (for the haptics: each change is a tap).
  private(set) var movesMade = 0
  private(set) var botMoves = 0
  /// What just happened that you didn't do (Midstrike's moves, mostly, and every turn and round that starts): the
  /// log's newest lines, each shown a few seconds as it rises and fades over the table.
  private(set) var feed: [FeedLine] = []
  private var feedCount = 0
  /// A move of yours was sent: the log lines that come back with it are yours, not news.
  private var awaitingMine = false

  struct FeedLine: Identifiable, Equatable {
    let id: Int
    let text: String
    let heading: Bool
  }
  /// Midstrike's last search: how many deals it played out, and how long it took.
  private(set) var lastSearch: ToAppSearch?
  /// Something went wrong (shown until dismissed).
  var problem: String?
  /// The card shown large while a finger holds it (a long press; letting go only puts it away).
  var preview: CardId?

  private var connection: Int?
  private var setup = Setup()
  /// Sent `start` for this setup (the room's messages that follow mustn't start it again).
  private var started = false
  /// For screenshots and trying the table (KEEPS_PLAY): your next moves, made at random.
  private var autoplay = 0

  init(core: Core, book: CardBook) {
    self.core = core
    self.book = book
    core.onSearch = { [weak self] search in self?.lastSearch = search }
    core.onFailure = { [weak self] message in self?.problem = message }
  }

  // MARK: Starting and leaving

  /// A new room with Midstrike, set up as `setup`, and its game started.
  func play(_ setup: Setup, autoplay: Int = 0) {
    leave()
    feed = []
    self.setup = setup
    self.autoplay = autoplay
    started = false
    screen = .starting
    let id = core.connect { [weak self] server in self?.received(server) }
    connection = id
    core.send(id, .create(ClientMessageCreate(name: setup.name, bot: true)))
  }

  /// The same game again, in the same room.
  func playAgain() {
    guard let connection else { return play(setup) }
    game = nil
    lines = []
    feed = []
    started = false
    screen = .starting
    core.send(connection, .backToLobby)
  }

  /// Back to the lobby; the room goes.
  func leave() {
    if let connection { core.close(connection) }
    connection = nil
    room = nil
    game = nil
    options = []
    lines = []
    table = nil
    picked = []
    dragging = nil
    landing = nil
    preview = nil
    feed = []
    awaitingMine = false
    screen = .lobby
  }

  // MARK: Playing

  /// Seats as the table draws them: yours at the bottom, then left, top, right.
  var me: Int {
    if case .number(let seat) = game?.view.viewer { return seat }
    return 0
  }
  func seat(at position: Int) -> Int { (me + position) % 4 }
  /// Midstrike's seat, if it's playing.
  var botSeat: Int? { room?.players.first(where: { $0.bot == true })?.seat }
  var training: Bool { room?.training ?? false }

  var touchable: Set<String> { Choosing.touchable(options, picked) }
  var remaining: [Option] { Choosing.narrow(options, picked) }

  func touchability(_ ref: String) -> Touchability {
    if let dragging { return ref == dragging.ref ? .picked : dragging.targets.contains(ref) ? .touchable : .none }
    return picked.contains(ref) ? .picked : touchable.contains(ref) ? .touchable : .none
  }

  // MARK: Dragging

  /// Something picked up from the table, and the moves letting it go makes: by where (an element, or "table" for the
  /// table's middle, "hand" for your hand), as the options declare their drags (web/src/game/options.ts): the app
  /// knows nothing of what any card does.
  struct Drag: Equatable {
    let ref: String
    let card: CardId?
    var location: CGPoint
    let moves: [String: [Option]]
    var targets: Set<String> { Set(moves.keys) }
  }

  /// Whether `ref` can be picked up now: some move is made by carrying it.
  func canDrag(_ ref: String) -> Bool { options.contains { $0.drags?.contains { $0.from == ref } == true } }

  func startDrag(_ ref: String, card: CardId?, at location: CGPoint) {
    var moves: [String: [Option]] = [:]
    for option in options {
      for drag in option.drags ?? [] where drag.from == ref { moves[drag.to, default: []].append(option) }
    }
    guard !moves.isEmpty else { return }
    picked = []
    dragging = Drag(ref: ref, card: ref.hasPrefix("pile:") ? nil : card, location: location, moves: moves)
  }

  /// What letting the carried thing go at `place` does, in words: its move, or how many there are to choose from.
  func dropWords(_ place: String) -> String? {
    guard let moves = dragging?.moves[place] else { return nil }
    return moves.count == 1 ? moves[0].label : "\(moves.count) moves: let go to choose"
  }

  func moveDrag(to location: CGPoint) { dragging?.location = location }

  /// The thing let go over `target` (an element, "table", "hand", or nil for nowhere): the move it makes there; if
  /// several, the moves left to choose from in the panel (as touching the thing, then the target, would leave them).
  /// Returns whether it went somewhere.
  @discardableResult
  func endDrag(on target: String?) -> Bool {
    guard let drag = dragging else { return false }
    dragging = nil
    guard let target, let moves = drag.moves[target] else { return false }
    if moves.count == 1 {
      landing = drag
      send(moves[0].command)
    } else {
      picked = [drag.ref] + (target == "table" || target == "hand" ? [] : [target])
    }
    return true
  }

  /// A touch on a table element (see Choosing).
  func touch(_ ref: String) {
    switch Choosing.touch(options, picked, ref) {
    case .send(let command): send(command)
    case .pick(let next): picked = next
    case .ignore: break
    }
  }

  func choose(_ item: Choosing.PanelItem) {
    switch item {
    case .option(let option): send(option.command)
    case .group(let ref, _, _): touch(ref)
    }
  }

  func clearPicked() { picked = [] }

  func send(_ command: Command) {
    picked = []
    guard let connection else { return }
    movesMade += 1
    awaitingMine = true
    core.send(connection, .command(ClientMessageCommand(command: command)))
  }

  func setTraining(_ on: Bool) {
    guard let connection else { return }
    core.send(connection, .training(ClientMessageTraining(on: on)))
  }

  // MARK: The server's messages

  private func received(_ server: ToAppServer) {
    switch server.message {
    case .room(let message):
      room = message.room
      guard message.room.phase == .lobby, screen == .starting, !started, let connection else { return }
      let wanted = settings(for: message.room)
      if message.room.settings != wanted {
        core.send(connection, .settings(ClientMessageSettings(settings: wanted)))
      } else {
        started = true
        core.send(connection, .start)
      }
    case .game(let message):
      // Midstrike's moves (a tap each), seen in the log's new entries.
      if let bot = botSeat, message.log.contains(where: { if case .action(let a) = $0.payload { return a.seat == bot } else { return false } }) {
        botMoves += 1
      }
      // What happened, unless it was your own move.
      let all = server.lines ?? []
      let fresh = all.count >= lines.count && game != nil ? Array(all.dropFirst(lines.count)) : []
      // (A turn or round that starts with it is news even so: your move may have ended your turn.)
      if awaitingMine, !fresh.isEmpty {
        awaitingMine = false
        tell(fresh.filter(\.heading))
      } else {
        tell(fresh)
      }
      // The table moves to the new position with its cards gliding to their new places.
      withAnimation(.snappy(duration: 0.35)) {
        // A new decision clears a half-made selection (and a card still being dragged).
        if message.view.legal != game?.view.legal {
          picked = []
          dragging = nil
        }
        game = message
        landing = nil
        options = server.options ?? []
        lines = server.lines ?? []
        table = server.table
        screen = .table
      }
      playAtRandom()
    case .error(let error):
      problem = error.message
    case .gone, .replaced:
      leave()
    case .welcome, .review:
      break
    }
  }

  /// Shows `lines` in the feed (the last few, if many came at once), each for a few seconds.
  private func tell(_ lines: [LogLine]) {
    for line in lines.suffix(4) {
      feedCount += 1
      let item = FeedLine(id: feedCount, text: line.text, heading: line.heading)
      withAnimation(.snappy(duration: 0.3)) {
        feed.append(item)
        if feed.count > 4 { feed.removeFirst(feed.count - 4) }
      }
      Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(5))
        withAnimation(.easeOut(duration: 0.6)) { self?.feed.removeAll { $0.id == item.id } }
      }
    }
  }

  /// KEEPS_PLAY's moves: a random one of your options, while there are some left to make (none of Duplicity's free reveals).
  private func playAtRandom() {
    guard autoplay > 0, let view = game?.view, view.phase == .playing || view.phase == .postRound else { return }
    let choices = options.filter { $0.command != .revealDuplicity }
    for prompt in view.prompts {
      if case .mine(.orderPile(let order)) = prompt {
        autoplay -= 1
        return send(.answer(CommandAnswer(promptId: order.id, answer: .orderPile(AnswerOrderPile(order: order.cards)))))
      }
    }
    guard view.prompts.contains(where: { $0.seat == me }), let option = choices.randomElement() else { return }
    autoplay -= 1
    let command = option.command
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(300))
      self.send(command)
    }
  }

  private func settings(for room: RoomSummary) -> Settings {
    let first: SettingsFirstPlayer
    switch setup.first {
    case .random: first = .random
    case .you: first = .object(SettingsFirstPlayerObject(player: room.you))
    case .midstrike: first = room.players.first(where: { $0.bot == true }).map { .object(SettingsFirstPlayerObject(player: $0.id)) } ?? .random
    }
    return Settings(marksToWin: Double(setup.marks), firstPlayer: first, botLevel: setup.level)
  }
}
