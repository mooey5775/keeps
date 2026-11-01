import SwiftUI

/// Under the table: what's happening (what you decide, or whom everyone waits on), the cards on display for your
/// decision, training mode's hints, and your moves: one row of small buttons (folded into groups when there are many),
/// all of them in a list a touch away, so the panel never covers the table. At the end of the game: play again, or leave.
struct DecisionPanel: View {
  let game: Game
  let view: PlayerView
  let table: TableText
  let leave: () -> Void
  @State private var allMoves = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let headline = table.headline {
        Text(headline).font(Theme.heading(21, relativeTo: .title3)).foregroundStyle(Theme.goldBright)
      }
      ForEach(Array(table.prompts.enumerated()), id: \.offset) { _, prompt in
        status(prompt)
      }
      if let shown = table.shown { ShownCards(game: game, shown: shown) }
      if let hints = table.hints, game.training { Hints(hints: hints) }
      options
      if let undo = game.game?.undo, undo.proposedBy != nil { UndoVote(game: game, undo: undo) }
      if view.phase == .gameOver {
        HStack {
          // Online, the host takes the room back to its lobby for the next game; the others wait for them.
          if game.online == nil || game.hosting {
            Button(game.online == nil ? "Play again" : "Back to the room") { game.playAgain() }
              .buttonStyle(.borderedProminent).tint(Theme.gold).foregroundStyle(Theme.background)
          } else {
            Text("The host starts the next game.").font(Theme.text(.footnote)).italic().foregroundStyle(Theme.muted)
          }
          Button("Leave", action: leave).buttonStyle(.bordered).tint(Theme.muted)
        }
        .font(Theme.text(.body))
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.ultraThinMaterial)
    .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 0.5) }
    .environment(\.colorScheme, .dark)
  }

  @ViewBuilder
  private func status(_ prompt: TableTextPromptsElement) -> some View {
    if prompt.mine {
      Text(prompt.text).font(Theme.text(.callout)).fontWeight(.semibold).foregroundStyle(Theme.goldBright)
    } else if prompt.seat == game.botSeat {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small).tint(Theme.muted)
        Text("\(table.names[prompt.seat]) is thinking…").font(Theme.text(.callout)).italic().foregroundStyle(Theme.muted)
      }
    } else {
      // (Waiting on someone who's away: said, so the wait isn't a mystery.)
      Text(prompt.text + (game.away(prompt.seat) ? " (\(table.names[prompt.seat]) is away)" : ""))
        .font(Theme.text(.callout)).foregroundStyle(Theme.muted)
    }
  }

  /// Your moves, in one row (the table is where they're mostly made: touched, or carried), and all of them a touch away.
  @ViewBuilder
  private var options: some View {
    let remaining = game.remaining
    if !remaining.isEmpty {
      let items = Choosing.panelItems(remaining, game.picked)
      HStack(spacing: 8) {
        if !game.picked.isEmpty {
          Button { game.clearPicked() } label: {
            Image(systemName: "arrow.uturn.backward").font(.body.weight(.semibold)).foregroundStyle(Theme.gold).frame(width: 36, height: 36)
          }
          .accessibilityLabel("Cancel selection")
        }
        ScrollView(.horizontal) {
          HStack(spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
              OptionChip(game: game, item: item, remaining: remaining)
            }
          }
        }
        .scrollIndicators(.hidden)
        // (Always: the row may scroll some out of sight.)
        Button { allMoves = true } label: {
          Image(systemName: "list.bullet").font(.body.weight(.semibold)).foregroundStyle(Theme.gold).frame(width: 36, height: 36)
            .background(Theme.panel.opacity(0.85), in: RoundedRectangle(cornerRadius: 10))
        }
        .accessibilityLabel("All moves")
      }
      .sheet(isPresented: $allMoves) { AllMovesSheet(game: game) }
    }
  }
}

/// Someone asked to take back the last move (a game between people): yours to agree to, or waited on.
struct UndoVote: View {
  let game: Game
  let undo: UndoState

  var body: some View {
    let names = game.room?.players ?? []
    let asker = names.first { $0.id == undo.proposedBy }?.name ?? "Someone"
    HStack(spacing: 10) {
      if let you = game.you, undo.waitingOn.contains(you) {
        Text("\(asker) asks to undo the last move.").font(Theme.text(.callout)).foregroundStyle(Theme.goldBright)
        Spacer(minLength: 0)
        Button("Agree") { game.voteUndo(true) }.buttonStyle(.borderedProminent).tint(Theme.gold).foregroundStyle(Theme.background)
        Button("No") { game.voteUndo(false) }.buttonStyle(.bordered).tint(Theme.muted)
      } else {
        let waiting = undo.waitingOn.compactMap { id in names.first { $0.id == id }?.name }
        Text("Undo asked: waiting for \(waiting.isEmpty ? "the others" : waiting.joined(separator: ", ")).")
          .font(Theme.text(.callout)).italic().foregroundStyle(Theme.muted)
      }
    }
  }
}

/// One of your moves (or a group of them), small, for the panel's row.
struct OptionChip: View {
  let game: Game
  let item: Choosing.PanelItem
  let remaining: [Option]

  var body: some View {
    Button {
      game.choose(item)
    } label: {
      HStack(spacing: 6) {
        ForEach(Array(OptionButton.cards(item, remaining).prefix(2).enumerated()), id: \.offset) { _, card in
          CardView(book: game.book, id: card, width: 18)
        }
        // (All of it, on as many lines as it takes: a move's words are never cut off.)
        Capped(width: 180) {
          Text(OptionButton.label(item)).font(Theme.text(.footnote)).foregroundStyle(Theme.text).multilineTextAlignment(.leading)
        }
        if case .group(_, _, let count) = item {
          Text("\(count)").font(.caption2.monospacedDigit()).foregroundStyle(Theme.muted)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 4)
      .frame(minHeight: 36, alignment: .leading)
      .background(Theme.panel.opacity(0.85), in: RoundedRectangle(cornerRadius: 10))
      .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 0.5) }
    }
    .buttonStyle(.plain)
  }
}

/// Its content at its natural width, up to `width`, and as tall as it then is: text wraps at the cap, and is measured
/// wrapped, even where it's offered any width (a horizontal scroll view's content is; a frame's maxWidth would measure
/// it on one line, then draw it wrapped, cut off at the top and bottom).
struct Capped: Layout {
  let width: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let content = subviews.first else { return .zero }
    return content.sizeThatFits(capped(content, proposal))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard let content = subviews.first else { return }
    content.place(at: bounds.origin, proposal: capped(content, proposal))
  }

  private func capped(_ content: LayoutSubview, _ proposal: ProposedViewSize) -> ProposedViewSize {
    let natural = content.sizeThatFits(.unspecified).width
    return ProposedViewSize(width: min(natural, width, proposal.width ?? .infinity), height: nil)
  }
}

/// Every move left, one per row (a group opens to its moves; a move closes the list).
struct AllMovesSheet: View {
  let game: Game
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let remaining = game.remaining
    let items = Choosing.panelItems(remaining, game.picked)
    NavigationStack {
      ScrollView {
        VStack(spacing: 6) {
          ForEach(Array(items.enumerated()), id: \.offset) { _, item in
            OptionButton(game: game, item: item, remaining: remaining) {
              if case .option = item { dismiss() }
            }
          }
        }
        .padding()
      }
      .background(Theme.background)
      .navigationTitle(game.picked.isEmpty ? "Your moves" : "Your moves (\(remaining.count))")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if !game.picked.isEmpty {
          ToolbarItem(placement: .cancellationAction) { Button("Back") { game.clearPicked() } }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .environment(\.colorScheme, .dark)
    .onChange(of: remaining.isEmpty) { _, empty in if empty { dismiss() } }
  }
}

/// One of your moves (or a group of them, "Play Dagger…"), with the cards it's about.
struct OptionButton: View {
  let game: Game
  let item: Choosing.PanelItem
  let remaining: [Option]
  var chosen: () -> Void = {}

  var body: some View {
    let label = Self.label(item)
    let cards = Self.cards(item, remaining)
    Button {
      game.choose(item)
      chosen()
    } label: {
      HStack(spacing: 8) {
        ForEach(Array(cards.enumerated()), id: \.offset) { _, card in
          CardView(book: game.book, id: card, width: 22)
        }
        Text(label).font(Theme.text(.subheadline)).foregroundStyle(Theme.text).multilineTextAlignment(.leading)
        Spacer(minLength: 0)
        if case .group(_, _, let count) = item {
          Text("\(count)").font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
          Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.muted)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
      .background(Theme.panel.opacity(0.85), in: RoundedRectangle(cornerRadius: 10))
      .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 0.5) }
    }
    .buttonStyle(.plain)
  }

  static func label(_ item: Choosing.PanelItem) -> String {
    switch item {
    case .option(let option): option.label
    case .group(_, let label, _): label
    }
  }

  /// The cards it's about (a group: those all its moves share).
  static func cards(_ item: Choosing.PanelItem, _ remaining: [Option]) -> [CardId] {
    switch item {
    case .option(let option): option.cards
    case .group(let ref, _, _): Choosing.groupCards(remaining, ref)
    }
  }
}

/// The cards on display for your decision (the pile you're looking through, the discard, revealed hands), each to touch if it's a choice.
struct ShownCards: View {
  let game: Game
  let shown: TableTextShown

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(shown.title).font(Theme.text(.footnote)).foregroundStyle(Theme.muted)
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 8) {
          ForEach(Array(shown.cards.enumerated()), id: \.offset) { _, card in
            VStack(spacing: 3) {
              TableCard(game: game, id: card.card, ref: card.ref, width: 64, placed: false)
              if let caption = card.caption { Text(caption).font(Theme.text(.caption)).foregroundStyle(Theme.muted) }
            }
          }
        }
        .padding(.top, 8)
      }
      .scrollIndicators(.hidden)
    }
  }
}

/// Training mode: the move Midstrike would play in your seat, and the next two.
struct Hints: View {
  let hints: [TableTextHintsElement]

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let best = hints.first {
        (Text("Midstrike would play: ").foregroundStyle(Theme.muted) + Text(best.label).bold().foregroundStyle(Theme.text)
          + Text("  \(best.chance)").foregroundStyle(Theme.gold))
          .font(Theme.text(.footnote))
        ForEach(Array(hints.dropFirst().prefix(2).enumerated()), id: \.offset) { _, hint in
          (Text(hint.label).foregroundStyle(Theme.muted) + Text("  \(hint.chance)").foregroundStyle(Theme.gold.opacity(0.8)))
            .font(Theme.text(.caption))
        }
      } else {
        HStack(spacing: 8) {
          ProgressView().controlSize(.mini)
          Text("Midstrike is thinking about your move…").font(Theme.text(.footnote)).italic().foregroundStyle(Theme.muted)
        }
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.blue.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
  }
}

/// Tithes: your pile, top first, in the order you drag it into.
struct OrderPileSheet: View {
  let game: Game
  let prompt: PromptViewMineOrderPile
  @State private var order: [CardId] = []

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(order, id: \.self) { card in
            HStack(spacing: 12) {
              Text("\((order.firstIndex(of: card) ?? 0) + 1)").font(.callout.monospacedDigit()).foregroundStyle(Theme.muted).frame(width: 22)
              CardView(book: game.book, id: card, width: 34)
              Text(game.book.name(card)).font(Theme.text(.body)).foregroundStyle(Theme.text)
            }
            .listRowBackground(Theme.raised)
          }
          .onMove { order.move(fromOffsets: $0, toOffset: $1) }
        } footer: {
          Text("Top of the pile first. Drag to reorder.").font(Theme.text(.footnote))
        }
      }
      .environment(\.editMode, .constant(.active))
      .scrollContentBackground(.hidden)
      .background(Theme.background)
      .navigationTitle("Tithes: your pile")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            game.send(.answer(CommandAnswer(promptId: prompt.id, answer: .orderPile(AnswerOrderPile(order: order)))))
          }
          .bold()
        }
      }
    }
    .onAppear { order = prompt.cards }
    .interactiveDismissDisabled()
    .presentationDetents([.medium, .large])
    .environment(\.colorScheme, .dark)
  }
}

/// The game's log, as the website writes it.
struct LogSheet: View {
  let lines: [LogLine]

  var body: some View {
    NavigationStack {
      ScrollViewReader { scroll in
        List(lines, id: \.seq) { line in
          Text(line.text)
            .font(line.heading ? Theme.heading(20, relativeTo: .headline) : Theme.text(.footnote))
            .foregroundStyle(line.heading ? Theme.goldBright : Theme.text)
            .padding(.leading, CGFloat(line.depth) * 12)
            .listRowBackground(Theme.background)
            .id(line.seq)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .onAppear { if let last = lines.last { scroll.scrollTo(last.seq, anchor: .bottom) } }
      }
      .navigationTitle("Game log")
      .navigationBarTitleDisplayMode(.inline)
    }
    .presentationDetents([.medium, .large])
    // A swipe scrolls the log, at either height (not the sheet's height).
    .presentationContentInteraction(.scrolls)
    .environment(\.colorScheme, .dark)
  }
}

/// The discard pile, oldest first.
struct DiscardSheet: View {
  let game: Game
  let cards: [CardId]

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 10)], spacing: 10) {
          ForEach(Array(cards.enumerated()), id: \.offset) { _, card in
            CardView(book: game.book, id: card, width: 76).previewable(card, in: game)
          }
        }
        .padding()
      }
      .background(Theme.background)
      .navigationTitle("Discard (\(cards.count))")
      .navigationBarTitleDisplayMode(.inline)
    }
    .presentationDetents([.medium, .large])
    .environment(\.colorScheme, .dark)
  }
}
