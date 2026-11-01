import SwiftUI

/// Where a game starts: on this phone, against Midstrike (its level, the marks to win, who plays first); or online, in
/// a room on the website's server, made here or joined by its code.
struct LobbyView: View {
  let game: Game
  /// Where you play from: on this phone, or online (the lobby opens where you last played).
  @AppStorage(LobbyView.placeKey) private var place = Place.phone
  static let placeKey = "where"
  @AppStorage("server") private var serverName = OnlineServer.midstrike.name
  @State private var code = ""
  @State private var confirmDiscard = false
  @FocusState private var coding: Bool

  enum Place: String { case phone, online }

  private var server: OnlineServer { OnlineServer.known.first { $0.name == serverName } ?? OnlineServer.known[0] }
  private var playerName: String {
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    return trimmed.isEmpty ? "Player" : trimmed
  }
  @AppStorage("name") private var name = ""
  @AppStorage("level") private var level = BotLevel.hard.rawValue
  @AppStorage("marks") private var marks = 3
  @AppStorage("first") private var first = Game.Setup.First.random.rawValue
  @FocusState private var naming: Bool

  var body: some View {
    ZStack {
      // Touching anywhere else puts the keyboard away.
      Theme.background.ignoresSafeArea().onTapGesture {
        naming = false
        coding = false
      }
      // The game's cards drifting down behind, a little veiled so the words stay clear.
      FallingCards(book: game.book).ignoresSafeArea()
      LinearGradient(colors: [Theme.background.opacity(0.35), Theme.background.opacity(0.7), Theme.background.opacity(0.35)], startPoint: .top, endPoint: .bottom)
        .ignoresSafeArea()
        .allowsHitTesting(false)
      VStack(spacing: 28) {
        Spacer()
        VStack(spacing: 6) {
          Text("KEEPS").font(Theme.heading(64, relativeTo: .largeTitle)).foregroundStyle(Theme.goldBright)
          Text(place == .phone ? "against Midstrike" : "online").font(Theme.text(.title3)).italic().foregroundStyle(Theme.muted)
        }
        Picker("Where", selection: $place) {
          Text("On this phone").tag(Place.phone)
          Text("Online").tag(Place.online)
        }
        .pickerStyle(.segmented)
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
          if place == .online { onlineRows } else { phoneRows }
        }
        .padding(20)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
        .environment(\.colorScheme, .dark)
        if place == .online { onlineButtons } else { phoneButtons }
        Spacer()
      }
      .padding(.horizontal, 24)
      .frame(maxWidth: 520)
    }
    .toolbar {
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Done") {
          naming = false
          coding = false
        }
      }
    }
  }

  // MARK: On this phone

  @ViewBuilder
  private var phoneRows: some View {
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

  private var phoneButtons: some View {
        VStack(spacing: 12) {
          // The game the app closed on, to take up again.
          if let kept = game.unfinished {
            Button { game.resume() } label: {
              VStack(spacing: 2) {
                Text("Continue").font(Theme.heading(30))
                Text(Self.describe(kept.game)).font(Theme.text(.footnote))
              }
              .frame(maxWidth: .infinity)
              .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.gold)
            .foregroundStyle(Theme.background)
            Button("Discard this game", role: .destructive) { confirmDiscard = true }
              .font(Theme.text(.footnote))
              .confirmationDialog("Discard the kept game?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard", role: .destructive) { game.discardKept() }
              } message: {
                Text("It can't be taken up again.")
              }
          }
          Button {
            game.play(Game.Setup(name: playerName, level: BotLevel(rawValue: level) ?? .hard, marks: marks, first: .init(rawValue: first) ?? .random))
          } label: {
            Text(game.unfinished == nil ? "Play" : "New game").font(Theme.heading(game.unfinished == nil ? 30 : 24)).frame(maxWidth: .infinity).padding(.vertical, 6)
          }
          .buttonStyle(.borderedProminent)
          .tint(game.unfinished == nil ? Theme.gold : Theme.panel)
          .foregroundStyle(game.unfinished == nil ? Theme.background : Theme.gold)
        }
  }

  // MARK: Online

  @ViewBuilder
  private var onlineRows: some View {
    if OnlineServer.known.count > 1 {
      row("Server") {
        Picker("Server", selection: $serverName) {
          ForEach(OnlineServer.known) { Text($0.name).tag($0.name) }
        }
      }
    } else {
      row("Server") { Text(server.name).font(Theme.text(.body)).foregroundStyle(Theme.text) }
    }
    row("Join a room") {
      HStack(spacing: 8) {
        TextField("Code", text: $code, prompt: Text("Its four letters").foregroundStyle(Theme.muted.opacity(0.7)))
          .font(Theme.text(.title3).monospaced())
          .foregroundStyle(Theme.text)
          .textInputAutocapitalization(.characters)
          .autocorrectionDisabled()
          .submitLabel(.join)
          .focused($coding)
          .onSubmit(joinRoom)
          // (Left as typed: rewriting it at each keystroke loses the next ones, typed quickly. Tidied when used.)
          .accessibilityIdentifier("room code")
        Button("Join", action: joinRoom)
          .buttonStyle(.borderedProminent)
          .tint(Theme.gold)
          .foregroundStyle(Theme.background)
          .disabled(roomCode.count != 4)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(Theme.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
      .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(coding ? Theme.gold : Theme.line, lineWidth: coding ? 1.5 : 1) }
    }
  }

  private var onlineButtons: some View {
    VStack(spacing: 12) {
      // The room you were in when the app closed, to go back to.
      if let seat = game.onlineSeat {
        Button { game.rejoin() } label: {
          VStack(spacing: 2) {
            Text("Back to \(seat.code)").font(Theme.heading(30))
            Text("on \(seat.server.name)").font(Theme.text(.footnote))
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.gold)
        .foregroundStyle(Theme.background)
      }
      Button { game.host(on: server, name: playerName) } label: {
        Text("Make a room").font(Theme.heading(game.onlineSeat == nil ? 30 : 24)).frame(maxWidth: .infinity).padding(.vertical, 6)
      }
      .buttonStyle(.borderedProminent)
      .tint(game.onlineSeat == nil ? Theme.gold : Theme.panel)
      .foregroundStyle(game.onlineSeat == nil ? Theme.background : Theme.gold)
    }
  }

  /// The code as typed, tidied: its letters, in capitals.
  private var roomCode: String { String(code.uppercased().filter(\.isLetter)) }

  private func joinRoom() {
    guard roomCode.count == 4 else { return }
    coding = false
    game.join(on: server, code: roomCode, name: playerName)
  }

  /// A kept game, in a few words: "Against Hard Midstrike, first to 3".
  private static func describe(_ game: GameRecord) -> String {
    let level = (game.settings.botLevel ?? .hard).rawValue.capitalized
    let marks = Int(game.settings.marksToWin)
    return "Against \(level) Midstrike, first to \(marks) \(marks == 1 ? "mark" : "marks")"
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
