import SwiftUI

/// A room online, between games: its code to share, who's in it, and the host's settings for the next game (the marks
/// to win, who plays first; Midstrike in the room, at a level, where the server has it), and the start.
struct RoomView: View {
  let game: Game
  @State private var confirmLeave = false

  var body: some View {
    if let room = game.room {
      ZStack {
        Theme.background.ignoresSafeArea()
        ScrollView {
          VStack(spacing: 22) {
            code(room)
            players(room)
            if game.hosting { settings(room) }
            start(room)
          }
          .padding(.horizontal, 20)
          .padding(.vertical, 24)
          .frame(maxWidth: 520)
          .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
      }
      .safeAreaInset(edge: .top) { linkBanner }
      .confirmationDialog("Leave the room?", isPresented: $confirmLeave, titleVisibility: .visible) {
        Button("Leave", role: .destructive) { game.leave() }
      }
    }
  }

  /// Dropped and coming back.
  @ViewBuilder
  private var linkBanner: some View {
    if game.online?.link == .reconnecting {
      Label("Reconnecting…", systemImage: "wifi.exclamationmark")
        .font(Theme.text(.footnote))
        .foregroundStyle(Theme.goldBright)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(Theme.panel)
    }
  }

  private func code(_ room: RoomSummary) -> some View {
    VStack(spacing: 6) {
      Text("Room").font(Theme.text(.subheadline)).foregroundStyle(Theme.muted)
      Text(room.code).font(Theme.heading(56, relativeTo: .largeTitle)).foregroundStyle(Theme.goldBright).kerning(6)
        .accessibilityIdentifier("room's code")
      if let online = game.online {
        Text("on \(online.server.name): others join with this code").font(Theme.text(.footnote)).foregroundStyle(Theme.muted)
        if let link = online.server.invite(room.code) {
          ShareLink(item: link, message: Text("Play Keeps with me: room \(room.code)")) {
            Label("Invite", systemImage: "square.and.arrow.up").font(Theme.text(.body))
          }
          .tint(Theme.gold)
        }
      }
    }
    .frame(maxWidth: .infinity)
  }

  private func players(_ room: RoomSummary) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Players (\(room.players.count) of 4)").font(Theme.text(.subheadline)).foregroundStyle(Theme.muted)
      ForEach(room.players, id: \.id) { player in
        HStack(spacing: 10) {
          Circle().fill(player.connected ? Color.green.opacity(0.8) : Theme.muted.opacity(0.5)).frame(width: 8, height: 8)
            .accessibilityHidden(true)
          Text(player.name + (player.id == room.you ? " (you)" : "")).font(Theme.text(.body)).foregroundStyle(Theme.text)
          Spacer()
          if player.bot == true { tag("bot") }
          if player.host { tag("host") }
          if !player.connected { tag("away") }
        }
        .accessibilityElement(children: .combine)
      }
    }
    .padding(16)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
    .environment(\.colorScheme, .dark)
  }

  private func tag(_ text: String) -> some View {
    Text(text).font(Theme.text(.caption)).foregroundStyle(Theme.muted)
      .padding(.horizontal, 8).padding(.vertical, 2)
      .overlay { Capsule().strokeBorder(Theme.line) }
  }

  /// The host's: the next game's settings, and Midstrike in or out.
  private func settings(_ room: RoomSummary) -> some View {
    let botIn = room.players.contains { $0.bot == true }
    return VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("First to").font(Theme.text(.subheadline)).foregroundStyle(Theme.muted)
        Spacer()
        Stepper(value: Binding(get: { Int(room.settings.marksToWin) }, set: { n in update(room) { $0.marksToWin = Double(n) } }), in: 1...10) {
          Text("\(Int(room.settings.marksToWin)) marks").font(Theme.text(.body)).foregroundStyle(Theme.text)
        }
        .fixedSize()
      }
      HStack {
        Text("First turn").font(Theme.text(.subheadline)).foregroundStyle(Theme.muted)
        Spacer()
        Picker("First turn", selection: Binding(get: { first(room) }, set: { id in update(room) { $0.firstPlayer = id.isEmpty ? .random : .object(SettingsFirstPlayerObject(player: id)) } })) {
          Text("Random").tag("")
          ForEach(room.players, id: \.id) { Text($0.name).tag($0.id) }
        }
        .tint(Theme.gold)
      }
      if room.botAvailable {
        if botIn, room.botLevels == true {
          Picker("Midstrike plays", selection: Binding(get: { room.settings.botLevel ?? .hard }, set: { level in update(room) { $0.botLevel = level } })) {
            Text("Easy").tag(BotLevel.easy)
            Text("Medium").tag(BotLevel.medium)
            Text("Hard").tag(BotLevel.hard)
          }
          .pickerStyle(.segmented)
        }
        Button(botIn ? "Remove Midstrike" : "Add Midstrike") { botIn ? game.removeBot() : game.addBot() }
          .font(Theme.text(.body))
          .tint(Theme.gold)
          .disabled(!botIn && room.players.count >= 2)
      }
    }
    .padding(16)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
    .environment(\.colorScheme, .dark)
  }

  private func first(_ room: RoomSummary) -> String {
    if case .object(let chosen) = room.settings.firstPlayer { return chosen.player }
    return ""
  }

  /// The room's settings with `body`'s change, sent (the rest as they are).
  private func update(_ room: RoomSummary, _ body: (inout Settings) -> Void) {
    var settings = room.settings
    body(&settings)
    game.change(settings)
  }

  private func start(_ room: RoomSummary) -> some View {
    VStack(spacing: 12) {
      if game.hosting {
        Button { game.start() } label: {
          Text("Start").font(Theme.heading(30)).frame(maxWidth: .infinity).padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.gold)
        .foregroundStyle(Theme.background)
        .disabled(room.players.count < 2)
        if room.players.count < 2 {
          Text("Waiting for someone to join.").font(Theme.text(.footnote)).foregroundStyle(Theme.muted)
        }
      } else {
        let host = room.players.first { $0.host }?.name ?? "The host"
        Text("\(host) starts the game.").font(Theme.text(.body)).italic().foregroundStyle(Theme.muted)
      }
      Button("Leave the room", role: .destructive) { confirmLeave = true }
        .font(Theme.text(.body))
    }
  }
}
