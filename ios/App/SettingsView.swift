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
          Toggle("Share my games on this phone", isOn: $sharing)
        } footer: {
          Text("Anonymous statistics about your games against Midstrike on this phone (who won, at which level, how long it took), to make Midstrike better. Online games are counted by the website's server either way.")
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
