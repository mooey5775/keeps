import SwiftUI

/// The game's makers, and where to buy it (the website's links: packages/web/src/screens/Home.tsx).
enum KeepsGame {
  static let site = URL(string: "https://www.keepsgame.com")!
  static let rules = URL(string: "https://www.keepsgame.com/how-to-play")!
  /// The buy link from keepsgame.com, with the creators' Amazon attribution tags.
  static let amazon = URL(string: "https://www.amazon.com/Keeps-an-Elegant-Game/dp/B0H7TBLY5X?maas=maas_adg_FEBF1A30E62A19690ED26156C54DC749_afap_abs&ref_=aa_maas&tag=maas")!
}

/// The app's settings: sharing the games played on the phone (Analytics: off until the person turns it on); the card
/// game itself, its makers and where to buy it, as the website has them; and which version this is.
struct SettingsView: View {
  @Environment(\.dismiss) private var dismiss
  @AppStorage(Analytics.sharingKey) private var sharing = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Toggle("Share statistics about my games on this phone", isOn: $sharing)
        } footer: {
          Text("How your games against Midstrike on this phone go (who won, at which level, how long they took), to make Midstrike better. They're sent with a random id for this phone, never your name or where you are. Online games are counted by the website's server either way.")
        }
        Section {
          Link(destination: KeepsGame.amazon) { Label("Buy Keeps on Amazon", systemImage: "cart") }
          Link(destination: KeepsGame.site) { Label("keepsgame.com", systemImage: "safari") }
          Link(destination: KeepsGame.rules) { Label("The rules", systemImage: "book") }
        } header: {
          Text("Keeps, the card game")
        } footer: {
          Text("Keeps is by David & Elaina Buffkin. Card art © their respective owners. Get your own copy to play at the table.")
        }
        Section("About") {
          LabeledContent("Version", value: "\(AppInfo.version) (\(AppInfo.build))")
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }
}
