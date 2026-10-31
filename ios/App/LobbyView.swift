import SwiftUI

/// Where a game starts: Midstrike's level, the marks to win, and who plays first.
struct LobbyView: View {
  let game: Game
  @AppStorage("name") private var name = ""
  @AppStorage("level") private var level = BotLevel.hard.rawValue
  @AppStorage("marks") private var marks = 3
  @AppStorage("first") private var first = Game.Setup.First.random.rawValue
  @FocusState private var naming: Bool

  var body: some View {
    ZStack {
      // Touching anywhere else puts the keyboard away.
      Theme.background.ignoresSafeArea().onTapGesture { naming = false }
      // The game's cards drifting down behind, a little veiled so the words stay clear.
      FallingCards(book: game.book).ignoresSafeArea()
      LinearGradient(colors: [Theme.background.opacity(0.35), Theme.background.opacity(0.7), Theme.background.opacity(0.35)], startPoint: .top, endPoint: .bottom)
        .ignoresSafeArea()
        .allowsHitTesting(false)
      VStack(spacing: 28) {
        Spacer()
        VStack(spacing: 6) {
          Text("KEEPS").font(Theme.heading(64, relativeTo: .largeTitle)).foregroundStyle(Theme.goldBright)
          Text("against Midstrike").font(Theme.text(.title3)).italic().foregroundStyle(Theme.muted)
        }
        VStack(alignment: .leading, spacing: 18) {
          row("Your name") {
            HStack(spacing: 8) {
              TextField("Your name", text: $name, prompt: Text("For the game's log").foregroundStyle(Theme.muted.opacity(0.7)))
                .font(Theme.text(.body))
                .foregroundStyle(Theme.text)
                .textContentType(.givenName)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($naming)
                .onSubmit { naming = false }
                .onChange(of: name) { _, new in if new.count > 20 { name = String(new.prefix(20)) } }  // the server's NAME_MAX
              Image(systemName: naming ? "checkmark.circle.fill" : "pencil")
                .foregroundStyle(naming ? Theme.gold : Theme.muted)
                .onTapGesture { naming.toggle() }
                .accessibilityHidden(true)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Theme.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(naming ? Theme.gold : Theme.line, lineWidth: naming ? 1.5 : 1) }
            .contentShape(Rectangle())
            .onTapGesture { naming = true }
          }
          row("Midstrike plays") {
            Picker("Level", selection: $level) {
              Text("Easy").tag(BotLevel.easy.rawValue)
              Text("Medium").tag(BotLevel.medium.rawValue)
              Text("Hard").tag(BotLevel.hard.rawValue)
            }
            .pickerStyle(.segmented)
          }
          Text(levelNote).font(Theme.text(.footnote)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
          row("First to") {
            Stepper(value: $marks, in: 1...5) {
              Text("\(marks) \(marks == 1 ? "mark" : "marks")").font(Theme.text(.body)).foregroundStyle(Theme.text)
            }
          }
          row("First turn") {
            Picker("First turn", selection: $first) {
              ForEach(Game.Setup.First.allCases) { Text($0.rawValue).tag($0.rawValue) }
            }
            .pickerStyle(.segmented)
          }
        }
        .padding(20)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
        .environment(\.colorScheme, .dark)
        Button {
          let trimmed = name.trimmingCharacters(in: .whitespaces)
          game.play(Game.Setup(name: trimmed.isEmpty ? "Player" : trimmed, level: BotLevel(rawValue: level) ?? .hard, marks: marks, first: .init(rawValue: first) ?? .random))
        } label: {
          Text("Play").font(Theme.heading(30)).frame(maxWidth: .infinity).padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.gold)
        .foregroundStyle(Theme.background)
        Spacer()
      }
      .padding(.horizontal, 24)
      .frame(maxWidth: 520)
    }
    .toolbar {
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Done") { naming = false }
      }
    }
  }

  private var levelNote: String {
    switch BotLevel(rawValue: level) ?? .hard {
    case .easy: "Plays its first instinct, at once."
    case .medium: "Thinks each move through 64 possible deals."
    case .hard: "Thinks each move through 512 possible deals."
    }
  }

  private func row<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).font(Theme.text(.subheadline)).foregroundStyle(Theme.muted)
      content()
    }
  }
}
