import SwiftUI

/// The table, for a narrow screen (a phone held upright): Midstrike at the top, the ghosts' piles and the discard in
/// the middle, your pile and keep below them, your hand, and under it all a panel with what you decide.
///
/// Every element that's part of a move (a card in your hand, a pile, a keep, a card in a keep, a player) is touched
/// to choose it, lit gold when worth touching (Choosing); the panel lists the moves left as buttons too. A card that
/// starts a move can be picked up and let go where it goes (a keep, a pile, the middle of the table to play it alone),
/// the places it can go lit as it's carried. A long press on a card shows it large, with the moves that involve it.
/// Cards glide from place to place as the game moves; moves, picks and round ends are felt as well as seen.
struct TableView: View {
  let game: Game
  @State private var showLog = false
  @State private var showDiscard = false
  @State private var confirmLeave = false
  @State private var confirmResign = false
  @State private var zones = DropZones()

  var body: some View {
    if let message = game.game, let table = game.table {
      let view = message.view
      GeometryReader { geo in
        let small = min(46, (geo.size.width - 40) / 7.6)
        let large = min(74, (geo.size.width - 40) / 5.2)
        let _ = (game.carriedWidth = large)
        ScrollView {
          VStack(spacing: game.others(view).count > 1 ? 6 : 8) {
            topBar(view)
            // The other players, in the order they play after you; then the middle; then you. (Two or three of them:
            // smaller, so the table still fits above your hand.)
            let others = game.others(view)
            ForEach(others, id: \.self) { seat in
              SeatArea(game: game, view: view, table: table, seat: seat, width: others.count > 1 ? small * 0.8 : small, compact: others.count > 1)
            }
            center(view, table, width: small)
            SeatArea(game: game, view: view, table: table, seat: game.me, width: small)
          }
          .padding(.horizontal, 16)
          .padding(.bottom, 8)
        }
        .scrollIndicators(.hidden)
        // Only when the table doesn't fit.
        .scrollBounceBehavior(.basedOnSize)
        .background(Theme.background.ignoresSafeArea())
        // Online, a dropped connection coming back.
        .safeAreaInset(edge: .top, spacing: 0) {
          if game.online?.link == .reconnecting {
            Label("Reconnecting…", systemImage: "wifi.exclamationmark")
              .font(Theme.text(.footnote))
              .foregroundStyle(Theme.goldBright)
              .padding(.vertical, 6)
              .frame(maxWidth: .infinity)
              .background(Theme.panel)
          }
        }
        // Your hand and your choices stay in view, whatever the table above them needs.
        .safeAreaInset(edge: .bottom, spacing: 0) {
          VStack(spacing: 0) {
            // What Midstrike just did, rising from above your hand and fading.
            Feed(lines: game.feed).padding(.horizontal, 16)
            hand(view, width: large).padding(.horizontal, 16).padding(.bottom, 6)
            DecisionPanel(game: game, view: view, table: table, leave: { confirmLeave = true })
          }
          .background(alignment: .bottom) { Theme.background.ignoresSafeArea() }
        }
        // While a card is carried or shown large, the table stays put under it.
        .scrollDisabled(game.dragging != nil || game.preview != nil)
        .overlay(alignment: .topLeading) {
          // The card carried. Placed by padding from the corner, so that its layout frame is where it's drawn.
          if let drag = game.dragging {
            CardView(book: game.book, id: drag.card, width: large, touch: .picked)
              .scaleEffect(1.08)
              .rotationEffect(.degrees(-3))
              .padding(.leading, drag.location.x - large / 2)
              .padding(.top, drag.location.y - large * 0.7)
              .allowsHitTesting(false)
          }
          // Cards moving across the table, one copy each, from where they were to their new places.
          ForEach(game.flights) { flight in
            CardView(book: game.book, id: flight.id, width: flight.frame.width)
              .padding(.leading, flight.frame.minX)
              .padding(.top, flight.frame.minY)
              .allowsHitTesting(false)
              .transition(.identity)
          }
        }
        .coordinateSpace(.named(DropZones.space))
      }
      // Cards set off from where they are now, and fly to their places once those are laid out.
      .onAppear {
        game.framesNow = { [zones] in zones.cardFrames }
        // (Weakly: the game holds the zones, through framesNow.)
        zones.onPlace = { [weak game = self.game] card, frame in game?.placed(card, at: frame) }
      }
      .environment(\.dropZones, zones)
      // What's felt: picking an element, picking up a card, each of your moves, each of Midstrike's, a round's end.
      .sensoryFeedback(.selection, trigger: game.picked)
      .sensoryFeedback(.selection, trigger: game.dragging?.ref)
      .sensoryFeedback(.impact(weight: .light), trigger: game.preview) { _, new in new != nil }
      .sensoryFeedback(.impact(weight: .medium), trigger: game.movesMade)
      .sensoryFeedback(.impact(weight: .light, intensity: 0.7), trigger: game.botMoves)
      .sensoryFeedback(trigger: view.phase) { _, phase in
        guard phase == .roundOver || phase == .gameOver else { return nil }
        return view.lastRoundWinner == game.me ? .success : .warning
      }
      .sheet(isPresented: $showLog) { LogSheet(lines: game.lines) }
      .sheet(isPresented: $showDiscard) { DiscardSheet(game: game, cards: view.discard) }
      .sheet(isPresented: .constant(orderPrompt(view) != nil)) {
        if let prompt = orderPrompt(view) { OrderPileSheet(game: game, prompt: prompt) }
      }
      .confirmationDialog("Resign this game?", isPresented: $confirmResign, titleVisibility: .visible) {
        Button("Resign", role: .destructive) { game.resign() }
      } message: {
        Text(game.others(view).count == 1 ? "\(table.names[game.others(view)[0]]) wins the game." : "This round ends with no winner, and the game goes on without you.")
      }
      .confirmationDialog("Leave the table?", isPresented: $confirmLeave, titleVisibility: .visible) {
        Button("Leave") { game.stepAway() }
      } message: {
        // (Over, there's nothing to go back to.)
        if view.phase != .gameOver {
          Text(game.online == nil ? "The game is kept: Continue takes it up." : "Your seat is kept: the others wait for you, and Back to \(game.room?.code ?? "the room") takes you there again.")
        }
      }
    }
  }

  private func orderPrompt(_ view: PlayerView) -> PromptViewMineOrderPile? {
    for prompt in view.prompts {
      if case .mine(.orderPile(let order)) = prompt { return order }
    }
    return nil
  }

  private func topBar(_ view: PlayerView) -> some View {
    HStack {
      Text("Round \(Int(view.round)) · first to \(Int(view.marksToWin)) \(view.marksToWin == 1 ? "mark" : "marks")")
        .font(Theme.text(.footnote)).foregroundStyle(Theme.muted)
      Spacer()
      Button { showLog = true } label: {
        Label("Log", systemImage: "list.bullet.rectangle")
          .font(Theme.text(.footnote))
          .foregroundStyle(Theme.gold)
          .padding(.horizontal, 10)
          .padding(.vertical, 5)
          .background(Theme.panel, in: Capsule())
          .overlay { Capsule().strokeBorder(Theme.line, lineWidth: 0.5) }
      }
      .accessibilityLabel("Game log")
      Menu {
        // (Training mode is Midstrike's advice: in a game against it.)
        if game.botSeat != nil {
          Toggle(isOn: Binding(get: { game.training }, set: { game.setTraining($0) })) {
            Label("Training mode", systemImage: "graduationcap")
          }
        }
        // (Undo, in a game between people: everyone else agrees to it.)
        if game.game?.undo.available == true {
          Button { game.proposeUndo() } label: { Label("Ask to undo the last move", systemImage: "arrow.uturn.backward") }
        }
        Divider()
        if view.phase != .gameOver {
          Button(role: .destructive) { confirmResign = true } label: { Label("Resign", systemImage: "flag") }
        }
        Button(role: .destructive) { confirmLeave = true } label: { Label("Leave game", systemImage: "xmark.circle") }
        #if DEBUG
        // (For tests: the core's process ended, as iOS may end it.)
        if ProcessInfo.processInfo.environment["KEEPS_TEST_HOOKS"] != nil {
          Button("End the core's process") { game.core.endProcessForTest() }
        }
        #endif
      } label: {
        Image(systemName: "ellipsis.circle").font(.title2).foregroundStyle(Theme.gold)
      }
      .accessibilityLabel("Game menu")
    }
    .padding(.top, 4)
  }

  /// The ghosts' piles either side of the discard: the middle of the table, where a card that makes a move on its own
  /// is let go to play it.
  private func center(_ view: PlayerView, _ table: TableText, width: CGFloat) -> some View {
    let words = game.dropWords("table")
    let open = words != nil
    // The ghosts' piles either side of the discard (two in a game for two, one for three, none for four). With
    // several other players to fit above, the discard's caption goes beside it.
    let ghosts = game.ghosts(view)
    let crowded = game.others(view).count > 1
    let pile = discard(view, width: crowded ? width : width * 1.1)
    return HStack(alignment: crowded ? .center : .top) {
      if let left = ghosts.first {
        PileStack(game: game, view: view, seat: left, width: width, caption: table.names[left])
      }
      Spacer()
      if crowded {
        HStack(spacing: 8) {
          pile
          Text("Discard · \(view.discard.count)").font(Theme.text(.caption)).foregroundStyle(Theme.muted)
        }
      } else {
        VStack(spacing: 4) {
          pile
          Text("Discard · \(view.discard.count)").font(Theme.text(.caption)).foregroundStyle(Theme.muted)
        }
      }
      Spacer()
      if ghosts.count > 1, let right = ghosts.last {
        PileStack(game: game, view: view, seat: right, width: width, caption: table.names[right])
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background {
      RoundedRectangle(cornerRadius: 14)
        .fill(open ? Theme.gold.opacity(0.1) : .clear)
        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(open ? Theme.gold : .clear, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])) }
    }
    .overlay(alignment: .bottom) {
      if let words { Text(words).font(Theme.text(.caption)).foregroundStyle(Theme.goldBright).lineLimit(1).offset(y: 14) }
    }
    .dropZone("table")
    .accessibilityIdentifier("table")
  }

  /// The discard's top card (touched, the whole pile in a sheet), or its empty place.
  @ViewBuilder
  private func discard(_ view: PlayerView, width: CGFloat) -> some View {
    if let top = view.discard.last {
      CardView(book: game.book, id: top, width: width)
        .opacity(game.travelling.contains(top) ? 0 : 1)
        .cardPlace(top)
        .transition(.asymmetric(insertion: .opacity, removal: .identity))
        .onTapGesture { showDiscard = true }
        .previewable(top, in: game)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Shows the discard pile")
    } else {
      EmptySlot(text: "discard", width: width)
    }
  }

  /// Your hand: also where your pile's top is let go, to draw it.
  private func hand(_ view: PlayerView, width: CGFloat) -> some View {
    let cards = view.hands[game.me].cards ?? []
    let words = game.dropWords("hand")
    let open = words != nil
    return VStack(alignment: .leading, spacing: 0) {
      Text(words ?? "Your hand").font(Theme.text(.caption)).foregroundStyle(open ? Theme.goldBright : Theme.muted).lineLimit(1)
      Fan(spacing: 8) {
        ForEach(cards, id: \.self) { card in
          TableCard(game: game, id: card, ref: "hand:\(card.rawValue)", width: width)
        }
        if cards.isEmpty { EmptySlot(text: "no cards", width: width) }
      }
      .padding(.top, width * 0.14)  // room for a touched card to lift
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background {
      RoundedRectangle(cornerRadius: 12)
        .fill(open ? Theme.gold.opacity(0.1) : .clear)
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(open ? Theme.gold : .clear, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])) }
        .padding(-4)
    }
    .dropZone("hand")
  }
}

/// A card on the table that's part of moves. A finger on it does one of three things, told apart by what it does
/// first: lifted at once, it touches the card (choosing it); moved, it carries the card to where it goes (when it
/// starts a move); held still a moment (three tenths of a second), it shows the card large until lifted, and nothing
/// else. The card glides when it moves to another place on the table.
struct TableCard: View {
  let game: Game
  let id: CardId?
  var faceDown = false
  /// What touching it chooses (nil: nothing, it's only there to see).
  let ref: String?
  let width: CGFloat
  /// Whether it's the card's place on the table (it glides from there), not a copy shown elsewhere.
  var placed = true
  @Environment(\.dropZones) private var zones
  /// How far a finger moves before it's carrying the card.
  private static let slack: CGFloat = 8

  var body: some View {
    let touch = ref.map(game.touchability) ?? .none
    // Carried (or let go and waiting for its move): the copy over the table is the card meanwhile; this one stays as a
    // ghost of where it came from, out of the glide.
    let lifted = ref != nil && game.dragging?.ref == ref
    // On its way to a new place (or from this one): its flight is drawn instead.
    let travelling = placed && id.map(game.travelling.contains) == true
    CardView(book: game.book, id: id, faceDown: faceDown, width: width, touch: touch)
      .opacity(lifted ? 0.25 : travelling ? 0 : 1)
      .cardPlace(placed ? id : nil)
      // A card leaving its place is gone at once: if it went somewhere on the table, its flight carries it there.
      .transition(.asymmetric(insertion: .opacity, removal: .identity))
      .modifier(DropZoneIf(ref: placed ? ref : nil))
      // A touch chooses it; a hold shows it until the finger lifts (and does nothing else); a carry takes it where it goes.
      // (Listened for only while touching it does something: otherwise the touch is for what holds it, as on the
      // website. A card in a full keep, when the keep is the target.)
      .gesture(TapGesture().onEnded { if let ref { game.touch(ref) } }, isEnabled: touch != .none)
      .previewable(id, in: game)
      // Only a card that can be picked up listens for a carry: on the others (those shown for a choice, in a row that
      // scrolls), a swipe has to reach the scrolling.
      .modifier(Carrying(enabled: ref.map(game.canDrag) == true, game: game, moved: carry, ended: drop))
      .accessibilityIdentifier(ref ?? "")
      .accessibilityAddTraits(touch == .none ? [] : .isButton)
      .accessibilityAction { if let ref, touch != .none { game.touch(ref) } }
      .accessibilityAction(named: "Show the card") { if let id { game.preview = id } }
  }

  /// The card carried to `location` (in the table's space): picked up, the first time.
  private func carry(to location: CGPoint) {
    guard let ref, game.preview == nil else { return }
    if game.dragging == nil {
      game.startDrag(ref, card: faceDown ? nil : id, at: location)
    } else {
      game.moveDrag(to: location)
    }
  }

  /// The card let go at `location` (nil: the carry was cancelled, and it goes back).
  private func drop(at location: CGPoint?) {
    guard let carried = game.dragging, carried.ref == ref else { return }
    let target = location.flatMap { zones.element(at: $0, among: carried.targets) }
    withAnimation(.snappy(duration: 0.3)) { _ = game.endDrag(on: target) }
  }
}

/// Carrying a card: UIKit's pan, so that it and the hold that shows a card (HoldToShow, also UIKit's) are told apart by
/// UIKit's own rules: a carry never begins while the card is shown, and moving before the hold's time ends the hold.
private struct Carrying: ViewModifier {
  let enabled: Bool
  let game: Game
  let moved: (CGPoint) -> Void
  let ended: (CGPoint?) -> Void

  func body(content: Content) -> some View {
    if enabled {
      content.gesture(Carry(allowed: { game.preview == nil }, moved: moved, ended: ended))
    } else {
      content
    }
  }
}

private struct Carry: UIGestureRecognizerRepresentable {
  let allowed: () -> Bool
  let moved: (CGPoint) -> Void
  let ended: (CGPoint?) -> Void

  func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator(allowed: allowed) }

  func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
    let pan = UIPanGestureRecognizer()
    pan.maximumNumberOfTouches = 1
    pan.delegate = context.coordinator
    return pan
  }

  func updateUIGestureRecognizer(_ pan: UIPanGestureRecognizer, context: Context) {
    context.coordinator.allowed = allowed
  }

  func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
    let location = context.converter.location(in: .named(DropZones.space))
    switch pan.state {
    case .began, .changed: moved(location)
    case .ended: ended(location)
    case .cancelled, .failed: ended(nil)
    default: break
    }
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var allowed: () -> Bool
    init(allowed: @escaping () -> Bool) { self.allowed = allowed }
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool { allowed() }
  }
}

private struct DropZoneIf: ViewModifier {
  let ref: String?

  func body(content: Content) -> some View {
    if let ref { content.dropZone(ref) } else { content }
  }
}

/// A seat: its name, marks, coins and hand, its pile and its keep.
struct SeatArea: View {
  let game: Game
  let view: PlayerView
  let table: TableText
  let seat: Int
  let width: CGFloat
  /// One of several other players: a smaller name, and less room around it.
  var compact = false

  var body: some View {
    let mine = seat == game.me
    let active = view.prompts.contains { $0.seat == seat }
    let player = game.touchability("player:\(seat)")
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        // The name; a gold button when the player is a choice (Pickpocket, Legerdemain): the whole row takes the touch.
        HStack(spacing: 6) {
          Text(table.names[seat]).font(Theme.heading(compact ? 18 : 22, relativeTo: .title3))
            .foregroundStyle(player == .none ? Theme.text : Theme.goldBright)
          if player != .none {
            Image(systemName: "hand.tap.fill").font(.footnote).foregroundStyle(Theme.goldBright)
          }
        }
        .padding(.horizontal, player == .none ? 0 : 10)
        .padding(.vertical, player == .none ? 0 : 3)
        .background {
          if player != .none {
            Capsule().fill(Theme.gold.opacity(player == .picked ? 0.35 : 0.18)).overlay { Capsule().strokeBorder(Theme.gold, lineWidth: 1.5) }
          }
        }
        .dropZone("player:\(seat)")
        .accessibilityAddTraits(player == .none ? [] : .isButton)
        if view.turn?.seat == seat {
          Circle().fill(Theme.gold).frame(width: 7, height: 7).accessibilityLabel("Their turn")
        }
        if game.away(seat) {
          Label("away", systemImage: "wifi.slash").font(Theme.text(.caption)).foregroundStyle(Theme.muted)
            .accessibilityIdentifier("\(table.names[seat]) away")
        }
        Spacer()
        Text(marks).font(.system(size: 13)).foregroundStyle(Theme.gold).accessibilityLabel("\(Int(view.marks[seat])) marks")
        Text("\(table.coins[seat])¢").font(Theme.text(.subheadline)).foregroundStyle(Theme.text)
        if !mine {
          Label("\(Int(view.hands[seat].count))", systemImage: "rectangle.portrait.on.rectangle.portrait")
            .font(Theme.text(.subheadline)).foregroundStyle(Theme.muted)
            .accessibilityLabel("\(Int(view.hands[seat].count)) cards in hand")
        }
      }
      HStack(alignment: .top, spacing: 12) {
        PileStack(game: game, view: view, seat: seat, width: width, caption: nil)
        KeepRow(game: game, view: view, table: table, seat: seat, width: width)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, compact ? 5 : 8)
    .background(Theme.raised, in: RoundedRectangle(cornerRadius: 14))
    .overlay(alignment: .top) {
      // Choosing the player: the header row is the button.
      if player != .none {
        Color.clear.frame(height: 44).contentShape(Rectangle()).onTapGesture { game.touch("player:\(seat)") }
      }
    }
    .overlay {
      RoundedRectangle(cornerRadius: 14).strokeBorder(active ? Theme.gold.opacity(0.7) : Theme.line, lineWidth: active ? 1.5 : 0.5)
    }
  }

  private var marks: String {
    (0..<Int(view.marksToWin)).map { $0 < Int(view.marks[seat]) ? "●" : "○" }.joined()
  }
}

/// A seat's pile: its top (the back, or a card turned face up) and how many cards it holds.
struct PileStack: View {
  let game: Game
  let view: PlayerView
  let seat: Int
  let width: CGFloat
  let caption: String?

  var body: some View {
    let pile = view.piles[seat]
    let ref = "pile:\(seat)"
    VStack(spacing: 4) {
      ZStack(alignment: .bottomTrailing) {
        if pile.size > 0 {
          TableCard(game: game, id: pile.top, faceDown: pile.top == nil, ref: ref, width: width)
        } else {
          EmptySlot(text: "empty", width: width, touch: game.touchability(ref))
            .onTapGesture { if game.touchability(ref) != .none { game.touch(ref) } }
        }
        Text("\(Int(pile.size))")
          .font(.system(size: 11, weight: .semibold).monospacedDigit())
          .padding(.horizontal, 5).padding(.vertical, 1)
          .background(Theme.background.opacity(0.85), in: Capsule())
          .foregroundStyle(Theme.text)
          .offset(x: 4, y: 4)
      }
      if let caption { Text(caption).font(Theme.text(.caption)).foregroundStyle(Theme.muted) }
    }
    .dropZone(ref)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(table(seat)) pile, \(Int(pile.size)) cards")
  }

  private func table(_ seat: Int) -> String { game.table?.possessive[seat] ?? "" }
}

/// A seat's keep: its played Keep cards (one may be face down), the whole keep a target for some moves.
struct KeepRow: View {
  let game: Game
  let view: PlayerView
  let table: TableText
  let seat: Int
  let width: CGFloat

  var body: some View {
    let keep = view.keeps[seat].cards
    let ref = "keep:\(seat)"
    let touch = game.touchability(ref)
    Fan(spacing: 6) {
      ForEach(Array(keep.enumerated()), id: \.element.key) { index, card in
        switch card {
        case .notFaceDown(let c):
          TableCard(game: game, id: c.id, ref: "keepcard:\(seat):\(index)", width: width)
        case .faceDown(let c):
          TableCard(game: game, id: c.id, faceDown: true, ref: "keepcard:\(seat):\(index)", width: width)
        }
      }
      if keep.isEmpty { Text("keep").font(Theme.text(.footnote)).italic().foregroundStyle(Theme.muted).frame(height: width * 1.4) }
    }
    .padding(.vertical, width * 0.12)
    .padding(.horizontal, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      RoundedRectangle(cornerRadius: 10)
        .fill(touch == .none ? Color.clear : Theme.gold.opacity(touch == .picked ? 0.25 : 0.12))
        .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(touch == .none ? Theme.line.opacity(0.6) : Theme.gold, style: StrokeStyle(lineWidth: 1, dash: touch == .none ? [4, 3] : [])) }
    }
    .contentShape(Rectangle())
    .onTapGesture { if touch != .none { game.touch(ref) } }
    .dropZone(ref)
    // The keep, its cards each reachable (VoiceOver's, and tests').
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(table.possessive[seat]) keep")
  }
}

extension KeepCardView {
  /// A keep card's identity in its row: the card, or (face down and unknown to you) its being the face-down one.
  var key: String {
    switch self {
    case .notFaceDown(let c): c.id.rawValue
    case .faceDown(let c): c.id?.rawValue ?? "face-down"
    }
  }
}

/// Where a card would be: dashed, with a word.
struct EmptySlot: View {
  let text: String
  let width: CGFloat
  var touch: Touchability = .none

  var body: some View {
    RoundedRectangle(cornerRadius: width * 0.07)
      .strokeBorder(touch == .none ? Theme.line : Theme.gold, style: StrokeStyle(lineWidth: touch == .none ? 1 : 2, dash: [4, 3]))
      .frame(width: width, height: width * 1.4)
      .overlay { Text(text).font(Theme.text(.caption)).italic().foregroundStyle(Theme.muted) }
  }
}

/// What just happened that you didn't do: the newest log lines, each rising from above your hand as the next comes and
/// fading after a few seconds.
struct Feed: View {
  let lines: [Game.FeedLine]

  var body: some View {
    // No height of its own: the lines rise over the table above.
    Color.clear.frame(height: 0).overlay(alignment: .bottomLeading) {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(lines) { line in
          Text(line.text)
            .font(line.heading ? Theme.heading(17, relativeTo: .headline) : Theme.text(.footnote))
            .foregroundStyle(line.heading ? Theme.goldBright : Theme.text)
            .lineLimit(2)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 9))
            .environment(\.colorScheme, .dark)
            .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity.combined(with: .offset(y: -16))))
        }
      }
      .padding(.bottom, 6)
      .frame(maxWidth: .infinity, alignment: .leading)
      // It takes no touches: it's over your seat, whose piles and cards must answer them (the Log button opens the log).
      .allowsHitTesting(false)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.updatesFrequently)
    }
  }
}


/// A card shown large, with its text, while a finger holds it (it takes no touches: lifting the finger puts it away).
struct CardPreview: View {
  let book: CardBook
  let id: CardId

  var body: some View {
    GeometryReader { geo in
      let width = min(geo.size.width - 56, 420, (geo.size.height - 220) / 1.4)
      ZStack {
        Color.black.opacity(0.6).ignoresSafeArea()
        VStack(spacing: 14) {
          CardView(book: book, id: id, width: width)
          Text(book.text(id))
            .font(Theme.text(.callout))
            .foregroundStyle(Theme.text)
            .multilineTextAlignment(.center)
            .frame(maxWidth: width)
        }
        .padding(18)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22))
        .environment(\.colorScheme, .dark)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .allowsHitTesting(false)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(book.name(id)): \(book.text(id))")
  }
}

extension View {
  /// Held still a moment (three tenths of a second, the finger wandering no more than a little), the card shows large
  /// until the finger lifts, wherever it moves meanwhile, and nothing else happens (see PreviewWindow).
  func previewable(_ id: CardId?, in game: Game) -> some View {
    gesture(
      HoldToShow(
        began: { if let id { game.preview = id } },
        ended: { if let id, game.preview == id { withAnimation(.easeOut(duration: 0.15)) { game.preview = nil } } }))
  }
}

/// UIKit's long press: once it begins, it follows the finger until it lifts, however far it then moves (SwiftUI's ends
/// when the finger wanders and a scroll view takes the touch). It works alongside the card's touch and carry, taking no
/// touches from them; the table stops scrolling while a card is shown (TableView's scrollDisabled), before the finger
/// can move.
private struct HoldToShow: UIGestureRecognizerRepresentable {
  let began: () -> Void
  let ended: () -> Void

  func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

  func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
    let hold = UILongPressGestureRecognizer()
    hold.minimumPressDuration = 0.3
    hold.allowableMovement = 8
    hold.cancelsTouchesInView = false
    hold.delegate = context.coordinator
    return hold
  }

  func handleUIGestureRecognizerAction(_ hold: UILongPressGestureRecognizer, context: Context) {
    switch hold.state {
    case .began: began()
    case .ended, .cancelled, .failed: ended()
    default: break
    }
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
  }
}
