import SwiftUI

/// Where a game starts: Midstrike's level, the marks to win, and who plays first.
struct LobbyView: View {
  let game: Game
  @AppStorage("name") private var name = ""
  @AppStorage("level") private var level = BotLevel.hard.rawValue
  @AppStorage("marks") private var marks = 3
  @AppStorage("first") private var first = Game.Setup.First.random.rawValue

  var body: some View {
    ZStack {
      Theme.background.ignoresSafeArea()
      VStack(spacing: 28) {
        Spacer()
        VStack(spacing: 6) {
          Text("Keeps").font(Theme.heading(64, relativeTo: .largeTitle)).foregroundStyle(Theme.goldBright)
          Text("against Midstrike").font(Theme.text(.title3)).italic().foregroundStyle(Theme.muted)
        }
        VStack(alignment: .leading, spacing: 18) {
          row("Your name") {
            TextField("Your name", text: $name, prompt: Text("For the game's log").foregroundStyle(Theme.muted))
              .font(Theme.text(.body))
              .textContentType(.givenName)
              .submitLabel(.done)
              .onChange(of: name) { _, new in if new.count > 20 { name = String(new.prefix(20)) } }  // the server's NAME_MAX
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
