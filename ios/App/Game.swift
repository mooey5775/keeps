import Foundation
import Observation
import SwiftUI

/// A game, as the app holds it: one connection, to the core's own server (a game against Midstrike on the phone) or to
/// the website's (online: a room others join by its code), both speaking the website's protocol; the room, and the
/// game's latest message with what the core worked out for it (the options, the log's lines, the table's words). The
/// views read it and call it; it never decides a rule.
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
  /// What's said while starting: a game being dealt, or taken up again.
  private(set) var starting = "Dealing…"
  enum Screen { case lobby, starting, room, table }

  /// Playing online: on which server, and how the connection is doing (nil: on the phone).
  private(set) var online: Online?

  struct Online: Equatable {
    let server: OnlineServer
    let name: String
    var link: LinkState = .connecting
  }

  /// A seat online, kept (UserDefaults) so a game there is taken up again after the app closes, as a browser's tab
  /// keeps its token: the server, the room, the seat's token.
  struct OnlineSeat: Codable, Equatable {
    let server: OnlineServer
    let code: String
    let token: String
    let name: String
  }

  /// The seat online the app last had, to take up again (the lobby offers it).
  private(set) var onlineSeat: OnlineSeat? = Game.loadSeat()
  private static let seatKey = "onlineSeat"

  private(set) var room: RoomSummary?
  /// The room's code in the NATO alphabet, to read out ("Mike · Tango · Uniform · Charlie").
  private(set) var roomSpelling: String?
  private(set) var game: ServerMessageGame?
  private(set) var options: [Option] = []
  private(set) var lines: [LogLine] = []
  private(set) var table: TableText?
  /// The table elements touched so far for the move being made.
  private(set) var picked: [String] = []
  /// The card being dragged, if one is.
  private(set) var dragging: Drag?
  /// Cards moving across the table: each drawn over it, from where it was to its new place (one card, never two).
  private(set) var flights: [Flight] = []
  /// The cards on their way: hidden in their places on the table until their flights land.
  private(set) var travelling: Set<CardId> = []
  /// Counts the positions that set cards off (a flight belongs to one).
  private var trips = 0
  /// The cards' frames on the table now, in the table's space (the table answers): where cards set off from.
  var framesNow: () -> [CardId: CGRect] = { [:] }
  /// The width a carried card is drawn at (the table says).
  var carriedWidth: CGFloat = 74

  struct Flight: Identifiable, Equatable {
    let id: CardId
    var frame: CGRect
    /// The position that set it off.
    var trip = 0
    var stage = Stage.setOff

    enum Stage {
      /// Let go, waiting where it was let go for the position the move makes.
      case waiting
      /// Set off by a new position: waits for its place there to be laid out.
      case setOff
      /// On its way to its place.
      case landing
    }
  }
  /// Moves you've made, and moves of Midstrike's seen (for the haptics: each change is a tap).
  private(set) var movesMade = 0
  private(set) var botMoves = 0
  /// What just happened that you didn't do (Midstrike's moves, mostly, and every turn and round that starts): the
  /// log's newest lines, each shown a few seconds as it rises and fades over the table.
  private(set) var feed: [FeedLine] = []
  private var feedCount = 0
  /// A move of yours was sent: the log lines that come back with it are yours, not news.
  private var awaitingMine = false
  /// The decisions you've sent a move for that the core hasn't yet shown answered (a second touch on the panel before
  /// the table moves on would answer one twice).
  private var answering: Set<String> = []

  struct FeedLine: Identifiable, Equatable {
    let id: Int
    let text: String
    let heading: Bool
  }
  /// Midstrike's last search: how many deals it played out, and how long it took.
  private(set) var lastSearch: ToAppSearch?
  /// Something went wrong (shown until dismissed).
  var problem: String?
  /// Something the room tells the table that isn't wrong at all (someone ended the game; you're the host now).
  var notice: String?
  /// The card shown large while a finger holds it (a long press; letting go only puts it away).
  var preview: CardId?

  /// The game the app kept unfinished when it last closed: the lobby offers to take it up again.
  private(set) var unfinished: Core.Kept?

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
    core.onEnded = { [weak self] in self?.coreEnded() }
    core.onRestarted = { [weak self] in self?.coreRestarted() }
    unfinished = core.kept()?.kept
  }

  /// When the core's process last ended (a few, recent): ending again and again, the game isn't taken up by itself.
  private var ends: [Date] = []
  /// Ending this many times within `endsWithin` seconds, the core is left be: back to the lobby, the game kept.
  private static let endsAllowed = 3
  private static let endsWithin: TimeInterval = 120

  /// The core's process ended, taking the room with it: the table waits for the game to be taken up again.
  private func coreEnded() {
    let now = Date()
    ends = ends.filter { now.timeIntervalSince($0) < Self.endsWithin } + [now]
    connection = nil
    dragging = nil
    picked = []
    if screen == .table || screen == .room {
      starting = online == nil ? "Taking up your game…" : "Reconnecting…"
      screen = .starting
    }
  }

  /// The core started again (its process ended, taking the room with it): the game in progress taken up again from
  /// what was kept; with nothing kept (a game not yet dealt, or over), back to the lobby.
  private func coreRestarted() {
    connection = nil
    guard screen != .lobby else { return unfinished = core.kept()?.kept }
    if ends.count >= Self.endsAllowed {
      // (Something in this game ends it each time: taking it up again would only end it again.)
      closeTable(forgetting: false)
      unfinished = core.kept()?.kept
      problem = "The game's engine stopped \(ends.count) times in a row, so it wasn't started again. Your game is kept: Continue takes it up."
      ends = []
    } else if online != nil, onlineSeat != nil {
      rejoin()
    } else if online == nil, core.kept() != nil {
      resume()
    } else {
      closeTable(forgetting: false)
    }
  }

  // MARK: Starting and leaving

  /// A new room with Midstrike, set up as `setup`, and its game started.
  func play(_ setup: Setup, autoplay: Int = 0) {
    closeTable()
    // (This game is the one kept from now on; the lobby opens here, where you last played.)
    unfinished = nil
    UserDefaults.standard.set(LobbyView.Place.phone.rawValue, forKey: LobbyView.placeKey)
    feed = []
    self.setup = setup
    self.autoplay = autoplay
    started = false
    starting = "Dealing…"
    screen = .starting
    let id = core.connect { [weak self] server in self?.received(server) }
    connection = id
    core.send(id, .create(ClientMessageCreate(name: setup.name, bot: true)))
  }

  /// The game kept unfinished, taken up where it was: the table as it was, Midstrike knowing what it knew.
  func resume(autoplay: Int = 0) {
    guard let found = core.kept() else { return unfinished = nil }
    closeTable(forgetting: false)
    self.autoplay = autoplay
    let record = found.kept.game
    let you = record.seats.first { $0.bot != true }
    setup = Setup(name: you?.name ?? "Player", level: record.settings.botLevel ?? .hard, marks: Int(record.settings.marksToWin))
    started = true
    starting = "Taking up your game…"
    screen = .starting
    connection = core.restore(found.kept, replay: found.replay) { [weak self] server in self?.received(server) }
  }

  // MARK: Online

  /// A new room on `server`, yours to set up and start (others join it by its code).
  func host(on server: OnlineServer, name: String) {
    goOnline(server, name: name, .create(ClientMessageCreate(name: name)), saying: "Making a room…")
  }

  /// The room `code` on `server`, joined.
  func join(on server: OnlineServer, code: String, name: String) {
    let code = code.trimmingCharacters(in: .whitespaces).uppercased()
    goOnline(server, name: name, .join(ClientMessageJoin(code: code, name: name)), saying: "Joining \(code)…")
  }

  /// The seat online kept from before, taken again.
  func rejoin() {
    guard let seat = onlineSeat else { return }
    goOnline(seat.server, name: seat.name, .resume(ClientMessageResume(code: seat.code, token: seat.token)), saying: "Back to \(seat.code)…")
  }

  private func goOnline(_ server: OnlineServer, name: String, _ hello: ClientMessage, saying: String) {
    closeTable(forgetting: false)
    UserDefaults.standard.set(LobbyView.Place.online.rawValue, forKey: LobbyView.placeKey)
    feed = []
    online = Online(server: server, name: name)
    starting = saying
    screen = .starting
    var id = 0
    id = core.connect(server: server.socket, { [weak self] message in self?.received(message) }, link: { [weak self] state in self?.linked(state, on: id) })
    connection = id
    core.send(id, hello)
  }

  /// How the connection online is doing: dropped and coming back (the table says so), or closed for good.
  private func linked(_ state: LinkState, on id: Int) {
    guard connection == id else { return }
    online?.link = state
    if state == .closed, screen != .lobby { closeTable(forgetting: false) }
  }

  /// Whether the player at `seat` is away: a person online whose connection is gone (the game waits on their moves).
  func away(_ seat: Int) -> Bool {
    guard online != nil, let player = room?.players.first(where: { $0.seat == seat }) else { return false }
    return player.bot != true && !player.connected
  }

  /// Your player id in the room, and whether you're its host.
  var you: String? { room?.you }
  var hosting: Bool { room?.players.first { $0.id == room?.you }?.host == true }

  /// The host's settings for the room's next game.
  func change(_ settings: Settings) {
    guard let connection else { return }
    core.send(connection, .settings(ClientMessageSettings(settings: settings)))
  }

  func addBot() { if let connection { core.send(connection, .addBot) } }
  func removeBot() { if let connection { core.send(connection, .removeBot) } }
  func start() { if let connection { core.send(connection, .start) } }
  /// Watching: take a free seat at the table (in the room's lobby).
  func sit() { if let connection { core.send(connection, .sit) } }
  /// Watch instead of playing; the host may move someone who's away (`player`) to watching, freeing their seat.
  func watch(_ player: String? = nil) { if let connection { core.send(connection, .watch(ClientMessageWatch(player: player))) } }
  /// Leaving the game for good: the room is told, and nothing is kept to go back to. Seated in a game still going, you
  /// resign (what that gives up, the core says: `table.leaving`). Not being at the table otherwise (the app closed or
  /// ended) keeps your seat, as a dead battery would.
  func leaveGame() {
    if let connection { core.send(connection, .leave) }
    closeTable()
  }

  /// The host's: everyone back to the room's lobby, the game ended first if it isn't over (no one wins).
  func endGame() {
    if let connection, hosting { core.send(connection, .backToLobby) }
  }

  /// The game the phone holds, while it's not at the table (one at a time): a seat online, or a game kept on the phone.
  var held: String? {
    if let seat = onlineSeat { return "room \(seat.code)" }
    if unfinished != nil { return "your game against Midstrike" }
    return nil
  }

  /// The game held, given up (to start another: the phone holds one at a time). Online, its room is told you've left
  /// (you resign there, and your seat goes to no one); on the phone, the kept game is discarded.
  func giveUpHeld() {
    if let seat = onlineSeat {
      keepSeat(nil)
      var id = 0
      // (The seat taken again, then left; closed once the server has answered, so both are sent.)
      id = core.connect(server: seat.server.socket) { [core] _ in core.close(id) }
      core.send(id, .resume(ClientMessageResume(code: seat.code, token: seat.token)))
      core.send(id, .leave)
    }
    if unfinished != nil { discardKept() }
  }

  /// Asks the other players to take back the last move (a game between people).
  func proposeUndo() { if let connection { core.send(connection, .proposeUndo) } }
  func voteUndo(_ accept: Bool) { if let connection { core.send(connection, .voteUndo(ClientMessageVoteUndo(accept: accept))) } }

  private static func loadSeat() -> OnlineSeat? {
    UserDefaults.standard.data(forKey: seatKey).flatMap { try? JSONDecoder().decode(OnlineSeat.self, from: $0) }
  }

  private func keepSeat(_ seat: OnlineSeat?) {
    onlineSeat = seat
    if let seat, let data = try? JSONEncoder().encode(seat) {
      UserDefaults.standard.set(data, forKey: Self.seatKey)
    } else {
      UserDefaults.standard.removeObject(forKey: Self.seatKey)
    }
  }

  /// The same game again, in the same room (online: the host takes the room back to its lobby, for the next game).
  func playAgain() {
    if online != nil {
      if let connection, hosting { core.send(connection, .backToLobby) }
      return
    }
    guard let connection else { return play(setup) }
    game = nil
    lines = []
    feed = []
    started = false
    starting = "Dealing…"
    screen = .starting
    core.send(connection, .backToLobby)
  }

  /// The game kept on the phone, given up (the lobby's Discard).
  func discardKept() {
    core.forgetKept()
    unfinished = nil
  }

  /// Back to the lobby, the connection closed as a crash would close it (the room keeps your seat); `forgetting`, the
  /// game kept to take up again goes too (it was left, or is over).
  private func closeTable(forgetting: Bool = true) {
    if forgetting, online != nil {
      keepSeat(nil)
    } else if forgetting, game != nil {
      core.forgetKept()
      unfinished = nil
    }
    if let connection { core.close(connection) }
    connection = nil
    online = nil
    room = nil
    game = nil
    options = []
    lines = []
    table = nil
    picked = []
    answering = []
    dragging = nil
    flights = []
    travelling = []
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

  /// The other players' seats, in the order they play after you (turns pass to the left: the next seat round): the
  /// table lists them so, down to yours.
  func others(_ view: PlayerView) -> [Int] { (1...3).map(seat(at:)).filter { view.seats[$0] == .player } }

  /// The ghosts' seats (piles, no player), in the same order.
  func ghosts(_ view: PlayerView) -> [Int] { (1...3).map(seat(at:)).filter { view.seats[$0] == .ghost } }
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
  /// table's middle, "hand" for your hand), as the options declare their drags (packages/table/src/options.ts): the app
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

  /// A card's place on the table, laid out at `frame`: a card on its way there flies to it. Its place reports it once
  /// the table has been laid out for the new position (only then is it known where that is).
  func placed(_ card: CardId, at frame: CGRect) {
    guard let index = flights.firstIndex(where: { $0.id == card && $0.stage == .setOff }) else { return }
    let trip = flights[index].trip
    flights[index].stage = .landing
    withAnimation(.snappy(duration: 0.32)) {
      flights[index].frame = frame
    } completion: { [weak self] in
      self?.landed(card, trip: trip)
    }
  }

  /// A flight over: the card is shown in its place.
  private func landed(_ card: CardId, trip: Int) {
    guard flights.contains(where: { $0.id == card && $0.trip == trip }) else { return }
    flights.removeAll { $0.id == card }
    travelling.remove(card)
  }

  /// Cards still waiting to set off after `seconds` (no place reported them: it may not show the card) are shown
  /// where they are instead of left hanging.
  private func grounding(_ trip: Int, after seconds: Double) {
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(seconds))
      guard let self else { return }
      for flight in self.flights where flight.trip == trip && flight.stage != .landing { self.landed(flight.id, trip: trip) }
    }
  }

  /// Where each card on the table is (a hand, a keep, the discard's top, a pile's top face up): a card whose place
  /// changes between two positions moves across the table.
  private static func places(_ view: PlayerView) -> [CardId: String] {
    var out: [CardId: String] = [:]
    for (seat, hand) in view.hands.enumerated() {
      for card in hand.cards ?? [] { out[card] = "hand:\(seat)" }
    }
    for keep in view.keeps {
      for card in keep.cards {
        switch card {
        case .notFaceDown(let c): out[c.id] = "keep:\(keep.seat)"
        case .faceDown(let c): if let id = c.id { out[id] = "keep:\(keep.seat)" }
        }
      }
    }
    for pile in view.piles {
      if let top = pile.top { out[top] = "pile:\(pile.position)" }
    }
    if let top = view.discard.last { out[top] = "discard" }
    return out
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
      // The card waits where it was let go (as carried), for the move's position to send it to its place.
      if send(moves[0].command), let card = drag.card {
        let width = carriedWidth * 1.08
        trips += 1
        flights = [Flight(id: card, frame: CGRect(x: drag.location.x - width / 2, y: drag.location.y - width * 0.7, width: width, height: width * 1.4), trip: trips, stage: .waiting)]
        travelling = [card]
        // (Should the position never come, the card isn't left hanging.)
        grounding(trips, after: 3)
      }
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

  /// Sends a move of yours; returns whether it went. Only an answer to a decision open in the position shown, and only
  /// one answer each (see Choosing.answersOpen).
  @discardableResult
  func send(_ command: Move) -> Bool {
    picked = []
    guard let connection, let game, Choosing.answersOpen(command, game.view.legal), answering.insert(Choosing.decision(command)).inserted
    else { return false }
    movesMade += 1
    awaitingMine = true
    core.send(connection, .command(ClientMessageCommand(command: command)))
    // The core answers a move at once (it's the next position, or why not). No answer means it's stuck: said so, and
    // the decision may be answered again, rather than every touch on it ignored in silence.
    let decision = Choosing.decision(command)
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(Self.answerWithin))
      guard let self, self.connection == connection, self.answering.remove(decision) != nil else { return }
      self.problem = "The game hasn't answered your move in \(Int(Self.answerWithin)) seconds."
    }
    return true
  }

  /// How long the core may take to answer a move (it answers at once; a test may hold its messages two seconds).
  private static let answerWithin: Double = 10

  func setTraining(_ on: Bool) {
    guard let connection else { return }
    core.send(connection, .training(ClientMessageTraining(on: on)))
  }

  // MARK: The server's messages

  private func received(_ server: ToAppServer) {
    switch server.message {
    case .room(let message):
      room = message.room
      roomSpelling = server.spelling
      if online != nil {
        // Online, the room's lobby is a screen of its own (whoever's in, the host's settings), between games too.
        if message.room.phase == .lobby, screen != .room {
          game = nil
          lines = []
          table = nil
          feed = []
          screen = .room
        }
        return
      }
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
      // The cards that change places set off from where they are (a card let go, from where it was let go); hidden in
      // their new places until they arrive there (TableView sends them, once the new position is laid out).
      let before = game.map { Self.places($0.view) } ?? [:]
      let after = Self.places(message.view)
      let frames = framesNow()
      trips += 1
      var setOff: [Flight] = []
      for (card, place) in after where before[card] != nil && before[card] != place {
        if let frame = flights.first(where: { $0.id == card })?.frame ?? frames[card] { setOff.append(Flight(id: card, frame: frame, trip: trips)) }
      }
      // (A card let go keeps waiting, should this position come before its move's: Midstrike's, say.)
      let waiting = flights.filter { flight in flight.stage == .waiting && !setOff.contains { $0.id == flight.id } }
      flights = setOff + waiting
      travelling = Set(flights.map(\.id))
      if !setOff.isEmpty { grounding(trips, after: 1) }
      // Decisions still open haven't been answered yet (this position may predate your move).
      answering.formIntersection(message.view.legal.map(Choosing.decision))
      // The table moves to the new position; cards within a row shift to their new places.
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
      // A move refused: its decision may be answered again.
      answering = []
      problem = error.message
      // Online, before a room was ours (no such room, the server unreachable): back to the lobby, as the website does.
      if online != nil, room == nil { closeTable(forgetting: false) }
    case .notice(let notice):
      self.notice = notice.message
    case .welcome(let welcome):
      // Online: the seat kept, to come back to.
      if let online { keepSeat(OnlineSeat(server: online.server, code: welcome.code, token: welcome.token, name: online.name)) }
    case .gone:
      if online != nil { problem = "That room is gone." }
      closeTable()
    case .replaced:
      if online != nil { problem = "Your seat was taken on another device." }
      closeTable()
    case .review:
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
        send(.answer(MoveAnswer(promptId: order.id, answer: .orderPile(AnswerOrderPile(order: order.cards)))))
        return
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
