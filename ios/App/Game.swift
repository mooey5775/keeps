import Foundation
import Observation

/// A game against Midstrike, as the app holds it: one connection to the core's server (the website's protocol), the
/// room it made, and the game's latest message with what the core worked out for it (the options, the log's lines,
/// the table's words). The views read it and call it; it never decides a rule.
@MainActor
@Observable
final class Game {
  /// How to start: Midstrike's level, the marks to win, who plays first.
  struct Setup: Equatable {
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
    core.send(id, .create(ClientMessageCreate(name: "You", bot: true)))
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
    picked.contains(ref) ? .picked : touchable.contains(ref) ? .touchable : .none
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
      // A new decision clears a half-made selection.
      if message.view.legal != game?.view.legal { picked = [] }
      game = message
      options = server.options ?? []
      lines = server.lines ?? []
      table = server.table
      screen = .table
      playAtRandom()
    case .error(let error):
      problem = error.message
    case .gone, .replaced:
      leave()
    case .welcome, .review:
      break
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
