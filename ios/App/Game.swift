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
  /// Moves you've made, and moves of Midstrike's seen (for the haptics: each change is a tap).
  private(set) var movesMade = 0
  private(set) var botMoves = 0
  /// What just happened that you didn't do (Midstrike's moves, mostly): the log's newest lines, each shown a few
  /// seconds as it rises and fades over the table.
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

  /// A card picked up from the table: where it can go (the elements that make a move with it), and whether letting it
  /// go in `aloneZone` makes a move on its own: a card from your hand in the middle of the table ("Play Hocus Pocus"),
  /// an ability card from your keep there too (to use it), your pile's top in your hand (to draw).
  struct Drag: Equatable {
    let ref: String
    let card: CardId?
    var location: CGPoint
    let targets: Set<String>
    let alone: Command?
    let aloneZone: String
    /// What letting it go in `aloneZone` does, in a few words.
    let aloneWords: String
  }

  /// Whether `ref` can be picked up: a card that starts a move (from your hand, or your keep), or your pile, to draw
  /// from it. (A drag starts afresh, whatever was touched.)
  func canDrag(_ ref: String) -> Bool {
    if ref.hasPrefix("pile:") { return ref == "pile:\(me)" && drawCommand != nil }
    return (ref.hasPrefix("hand:") || ref.hasPrefix("keepcard:")) && Choosing.touchable(options, []).contains(ref)
  }

  /// Drawing from your pile, when it's a move now.
  private var drawCommand: Command? {
    options.first { option in
      guard option.refs == ["pile:\(me)"], case .answer(let answer) = option.command, case .action(let action) = answer.answer,
        case .draw = action.choice
      else { return false }
      return true
    }?.command
  }

  func startDrag(_ ref: String, card: CardId?, at location: CGPoint) {
    picked = []
    if ref.hasPrefix("pile:") {
      dragging = Drag(ref: ref, card: nil, location: location, targets: [], alone: drawCommand, aloneZone: "hand", aloneWords: "Let go to draw")
      return
    }
    let moves = Choosing.narrow(options, [ref])
    dragging = Drag(
      ref: ref, card: card, location: location,
      targets: Set(moves.flatMap(\.refs)).subtracting([ref]),
      alone: moves.first(where: { $0.refs == [ref] })?.command,
      aloneZone: "middle",
      aloneWords: ref.hasPrefix("keepcard:") ? "Let go here to use it" : "Let go here to play it")
  }

  func moveDrag(to location: CGPoint) { dragging?.location = location }

  /// The card let go over `target` (an element, "middle" for the middle of the table, or nil for nowhere): the move
  /// it makes, as touching the card then the target would; the rest of the move picked if it needs more. Returns
  /// whether it went somewhere.
  @discardableResult
  func endDrag(on target: String?) -> Bool {
    guard let drag = dragging else { return false }
    dragging = nil
    if target == drag.aloneZone, let alone = drag.alone {
      send(alone)
      return true
    }
    guard let target, drag.targets.contains(target) else { return false }
    switch Choosing.touch(options, [drag.ref], target) {
    case .send(let command): send(command)
    case .pick(let next): picked = next
    case .ignore: return false
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
      if awaitingMine, !fresh.isEmpty { awaitingMine = false } else { tell(fresh) }
      // The table moves to the new position with its cards gliding to their new places.
      withAnimation(.snappy(duration: 0.35)) {
        // A new decision clears a half-made selection (and a card still being dragged).
        if message.view.legal != game?.view.legal {
          picked = []
          dragging = nil
        }
        game = message
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
