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
  @State private var zones = DropZones()
  @Namespace private var cards

  var body: some View {
    if let message = game.game, let table = game.table {
      let view = message.view
      GeometryReader { geo in
        let small = min(46, (geo.size.width - 40) / 7.6)
        let large = min(74, (geo.size.width - 40) / 5.2)
        ScrollView {
          VStack(spacing: 8) {
            topBar(view)
            SeatArea(game: game, view: view, table: table, seat: game.seat(at: 2), width: small)
            center(view, table, width: small)
            SeatArea(game: game, view: view, table: table, seat: game.me, width: small)
          }
          .padding(.horizontal, 16)
          .padding(.bottom, 8)
        }
        .scrollIndicators(.hidden)
        .background(Theme.background.ignoresSafeArea())
        // Your hand and your choices stay in view, whatever the table above them needs.
        .safeAreaInset(edge: .bottom, spacing: 0) {
          VStack(spacing: 0) {
            // What Midstrike just did, rising from above your hand and fading.
            Feed(lines: game.feed) { showLog = true }.padding(.horizontal, 16)
            hand(view, width: large).padding(.horizontal, 16).padding(.bottom, 6)
            DecisionPanel(game: game, view: view, table: table, leave: { confirmLeave = true })
          }
          .background(alignment: .bottom) { Theme.background.ignoresSafeArea() }
        }
        // While a card is carried, the table stays put under it.
        .scrollDisabled(game.dragging != nil)
        .overlay(alignment: .topLeading) {
          if let drag = game.dragging {
            CardView(book: game.book, id: drag.card, width: large, touch: .picked)
              .scaleEffect(1.08)
              .rotationEffect(.degrees(-3))
              .position(drag.location)
              .allowsHitTesting(false)
          }
        }
        .coordinateSpace(.named(DropZones.space))
      }
      .overlay {
        if let id = game.preview { CardPreview(book: game.book, id: id).transition(.opacity.combined(with: .scale(scale: 0.92))) }
      }
      .animation(.snappy(duration: 0.2), value: game.preview)
      .environment(\.dropZones, zones)
      .environment(\.cardSpace, cards)
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
      .confirmationDialog("Leave this game?", isPresented: $confirmLeave, titleVisibility: .visible) {
        Button("Leave", role: .destructive) { game.leave() }
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
        Toggle(isOn: Binding(get: { game.training }, set: { game.setTraining($0) })) {
          Label("Training mode", systemImage: "graduationcap")
        }
        Divider()
        Button(role: .destructive) { confirmLeave = true } label: { Label("Leave game", systemImage: "xmark.circle") }
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
    let open = game.dragging.map { $0.alone != nil && $0.aloneZone == "middle" } ?? false
    return HStack(alignment: .top) {
      PileStack(game: game, view: view, seat: game.seat(at: 1), width: width, caption: table.names[game.seat(at: 1)])
      Spacer()
      VStack(spacing: 4) {
        if let top = view.discard.last {
          CardView(book: game.book, id: top, width: width * 1.1)
            .matchedGeometryEffect(id: top, in: cards)
            .onTapGesture { showDiscard = true }
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Shows the discard pile")
        } else {
          EmptySlot(text: "discard", width: width * 1.1)
        }
        Text("Discard · \(view.discard.count)").font(Theme.text(.caption)).foregroundStyle(Theme.muted)
      }
      Spacer()
      PileStack(game: game, view: view, seat: game.seat(at: 3), width: width, caption: table.names[game.seat(at: 3)])
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background {
      RoundedRectangle(cornerRadius: 14)
        .fill(open ? Theme.gold.opacity(0.1) : .clear)
        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(open ? Theme.gold : .clear, style: StrokeStyle(lineWidth: 1.5, dash: [6, 4])) }
    }
    .overlay(alignment: .bottom) {
      if open, let words = game.dragging?.aloneWords { Text(words).font(Theme.text(.caption)).foregroundStyle(Theme.goldBright).offset(y: 14) }
    }
    .dropZone("middle")
    .accessibilityIdentifier("middle")
  }

  /// Your hand: also where your pile's top is let go, to draw it.
  private func hand(_ view: PlayerView, width: CGFloat) -> some View {
    let cards = view.hands[game.me].cards ?? []
    let open = game.dragging.map { $0.alone != nil && $0.aloneZone == "hand" } ?? false
    return VStack(alignment: .leading, spacing: 0) {
      Text(open ? (game.dragging?.aloneWords ?? "") : "Your hand").font(Theme.text(.caption)).foregroundStyle(open ? Theme.goldBright : Theme.muted)
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
/// starts a move); held still a moment, it shows the card large until lifted, and nothing else (no move, no carry).
/// The card glides when it moves to another place on the table.
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
  @Environment(\.cardSpace) private var space
  @State private var press = Press.idle
  @State private var holding: Task<Void, Never>?

  /// What a finger on the card is doing.
  private enum Press { case idle, down, previewing, carrying, slid }

  /// How long a finger stays still before the card is shown large, and how far it may wander meanwhile.
  private static let hold = Duration.milliseconds(320)
  private static let slack: CGFloat = 8

  var body: some View {
    let touch = ref.map(game.touchability) ?? .none
    let carried = ref != nil && game.dragging?.ref == ref
    CardView(book: game.book, id: id, faceDown: faceDown, width: width, touch: touch)
      .opacity(carried ? 0.25 : 1)
      .modifier(Glide(id: placed ? id : nil, space: space))
      .modifier(DropZoneIf(ref: placed ? ref : nil))
      .gesture(finger)
      .accessibilityIdentifier(ref ?? "")
      .accessibilityAddTraits(touch == .none ? [] : .isButton)
      .accessibilityAction { if let ref, touch != .none { game.touch(ref) } }
      .accessibilityAction(named: "Show the card") { if let id { game.preview = id } }
  }

  private var finger: some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .named(DropZones.space))
      .onChanged { drag in
        switch press {
        case .idle:
          press = .down
          holding = Task { @MainActor in
            try? await Task.sleep(for: Self.hold)
            guard !Task.isCancelled, press == .down, let id else { return }
            press = .previewing
            game.preview = id
          }
        case .down:
          guard hypot(drag.translation.width, drag.translation.height) > Self.slack else { return }
          holding?.cancel()
          if let ref, game.canDrag(ref) {
            press = .carrying
            game.startDrag(ref, card: faceDown ? nil : id, at: drag.location)
          } else {
            press = .slid
          }
        case .carrying:
          game.moveDrag(to: drag.location)
        case .previewing, .slid:
          break
        }
      }
      .onEnded { drag in
        holding?.cancel()
        switch press {
        case .down:
          if let ref, game.touchability(ref) != .none { game.touch(ref) }
        case .carrying:
          if let carried = game.dragging {
            let target = zones.element(at: drag.location, among: carried.targets.union([carried.aloneZone]))
            withAnimation(.snappy(duration: 0.3)) { _ = game.endDrag(on: target) }
          }
        case .previewing:
          withAnimation(.easeOut(duration: 0.15)) { game.preview = nil }
        case .idle, .slid:
          break
        }
        press = .idle
      }
  }
}

/// A card's identity on the table, for gliding to its next place (none for a card back or a copy).
private struct Glide: ViewModifier {
  let id: CardId?
  let space: Namespace.ID?

  func body(content: Content) -> some View {
    if let id, let space {
      content.matchedGeometryEffect(id: id, in: space).transition(.scale(scale: 0.7).combined(with: .opacity))
    } else {
      content
    }
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

  var body: some View {
    let mine = seat == game.me
    let active = view.prompts.contains { $0.seat == seat }
    let player = game.touchability("player:\(seat)")
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        // The name; a gold button when the player is a choice (Pickpocket, Legerdemain): the whole row takes the touch.
        HStack(spacing: 6) {
          Text(table.names[seat]).font(Theme.heading(22, relativeTo: .title3))
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
    .padding(.vertical, 8)
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
/// fading after a few seconds. Touching them opens the whole log.
struct Feed: View {
  let lines: [Game.FeedLine]
  let open: () -> Void

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
      .contentShape(Rectangle())
      .onTapGesture(perform: open)
      .allowsHitTesting(!lines.isEmpty)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.updatesFrequently)
      .accessibilityHint("Opens the game log")
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
