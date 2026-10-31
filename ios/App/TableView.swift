import SwiftUI

/// The table, for a narrow screen (a phone held upright): Midstrike at the top, the ghosts' piles and the discard in
/// the middle, your pile and keep below them, your hand, and under it all a panel with what you decide.
///
/// Every element that's part of a move (a card in your hand, a pile, a keep, a card in a keep, a player) is touched
/// to choose it, lit gold when worth touching (Choosing); the panel lists the moves left as buttons too. A long press
/// on a card shows it large, with the moves that involve it.
struct TableView: View {
  let game: Game
  @State private var showLog = false
  @State private var showDiscard = false
  @State private var confirmLeave = false

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
            hand(view, width: large).padding(.horizontal, 16).padding(.bottom, 6)
            DecisionPanel(game: game, view: view, table: table, leave: { confirmLeave = true })
          }
          .background(alignment: .bottom) { Theme.background.ignoresSafeArea() }
        }
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
      Menu {
        Toggle(isOn: Binding(get: { game.training }, set: { game.setTraining($0) })) {
          Label("Training mode", systemImage: "graduationcap")
        }
        Button { showLog = true } label: { Label("Game log", systemImage: "list.bullet.rectangle") }
        Divider()
        Button(role: .destructive) { confirmLeave = true } label: { Label("Leave game", systemImage: "xmark.circle") }
      } label: {
        Image(systemName: "ellipsis.circle").font(.title2).foregroundStyle(Theme.gold)
      }
      .accessibilityLabel("Game menu")
    }
    .padding(.top, 4)
  }

  /// The ghosts' piles either side of the discard.
  private func center(_ view: PlayerView, _ table: TableText, width: CGFloat) -> some View {
    HStack(alignment: .top) {
      PileStack(game: game, view: view, seat: game.seat(at: 1), width: width, caption: table.names[game.seat(at: 1)])
      Spacer()
      VStack(spacing: 4) {
        if let top = view.discard.last {
          CardView(book: game.book, id: top, width: width * 1.1)
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
  }

  private func hand(_ view: PlayerView, width: CGFloat) -> some View {
    let cards = view.hands[game.me].cards ?? []
    return VStack(alignment: .leading, spacing: 0) {
      Text("Your hand").font(Theme.text(.caption)).foregroundStyle(Theme.muted)
      ScrollView(.horizontal) {
        HStack(spacing: 8) {
          ForEach(Array(cards.enumerated()), id: \.offset) { _, card in
            TableCard(game: game, id: card, ref: "hand:\(card.rawValue)", width: width)
          }
          if cards.isEmpty { EmptySlot(text: "no cards", width: width) }
        }
        .padding(.top, width * 0.14)  // room for a touched card to lift
        .padding(.horizontal, 2)
      }
      .scrollIndicators(.hidden)
    }
  }
}

/// A card on the table that's part of moves: touched to choose it, long-pressed to see it (and its moves).
struct TableCard: View {
  let game: Game
  let id: CardId?
  var faceDown = false
  /// What touching it chooses (nil: nothing, it's only there to see).
  let ref: String?
  let width: CGFloat

  var body: some View {
    let touch = ref.map(game.touchability) ?? .none
    let moves = ref.map { ref in game.options.filter { $0.refs.contains(ref) } } ?? []
    CardView(book: game.book, id: id, faceDown: faceDown, width: width, touch: touch)
      .onTapGesture {
        if let ref, touch != .none { game.touch(ref) }
      }
      .contextMenu {
        ForEach(Array(moves.prefix(12).enumerated()), id: \.offset) { _, option in
          Button(option.label) { game.send(option.command) }
        }
      } preview: {
        if let id {
          VStack(spacing: 10) {
            CardView(book: game.book, id: id, width: 240)
            Text(game.book.text(id)).font(Theme.text(.footnote)).foregroundStyle(Theme.text).multilineTextAlignment(.center)
          }
          .padding(16)
          .frame(width: 280)
          .background(Theme.panel)
        } else {
          CardView(book: game.book, id: nil, width: 240).padding(16).background(Theme.panel)
        }
      }
      .accessibilityAddTraits(touch == .none ? [] : .isButton)
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
        Text(table.names[seat]).font(Theme.heading(22, relativeTo: .title3))
          .foregroundStyle(player == .none ? Theme.text : Theme.goldBright)
          .onTapGesture { if player != .none { game.touch("player:\(seat)") } }
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
    ScrollView(.horizontal) {
      HStack(spacing: 6) {
        ForEach(Array(keep.enumerated()), id: \.offset) { index, card in
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
    }
    .scrollIndicators(.hidden)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      RoundedRectangle(cornerRadius: 10)
        .fill(touch == .none ? Color.clear : Theme.gold.opacity(touch == .picked ? 0.25 : 0.12))
        .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(touch == .none ? Theme.line.opacity(0.6) : Theme.gold, style: StrokeStyle(lineWidth: 1, dash: touch == .none ? [4, 3] : [])) }
    }
    .contentShape(Rectangle())
    .onTapGesture { if touch != .none { game.touch(ref) } }
    .accessibilityLabel("\(table.possessive[seat]) keep")
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
