import SwiftUI

/// The app's settings: sharing the games played on the phone (Analytics: off until the person turns it on), and which
/// version this is.
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
