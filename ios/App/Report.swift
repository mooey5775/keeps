import SwiftUI
import UIKit

/// A bug report, as the website's "Think a rule was applied wrong?" sends one (its server's POST /dispute): what happened,
/// how to reach you, the app's version and device, a screenshot taken as the report began, and the game you're in (an
/// online room's seat, or the game on the phone, its replay). Shaking the phone starts one; so does "Report a problem"
/// in the menus (a shake can't be found by looking, and the UI tests can't shake).
struct Report: Identifiable {
  let id = UUID()
  /// The screen as it was when the report began (JPEG).
  let screenshot: Data?

  /// A report of the screen as it is now.
  @MainActor static func now() -> Report { Report(screenshot: Self.screen()) }

  /// The key window, drawn at one pixel a point (enough to see, and small to send).
  @MainActor private static func screen() -> Data? {
    guard let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
    }
    return image.jpegData(compressionQuality: 0.6)
  }
}

extension Notification.Name {
  /// The phone was shaken (UIWindow's motionEnded, below).
  static let shaken = Notification.Name("keeps.shaken")
}

extension UIWindow {
  open override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
    if motion == .motionShake { NotificationCenter.default.post(name: .shaken, object: nil) }
    super.motionEnded(motion, with: event)
  }
}

struct ReportView: View {
  let game: Game
  let report: Report
  @Environment(\.dismiss) private var dismiss
  @AppStorage("name") private var name = ""
  @State private var text = ""
  @State private var contact = ""
  @State private var withScreenshot = true
  @State private var sending = false
  @State private var failure: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("What happened?", text: $text, axis: .vertical)
            .lineLimit(4...10)
            .accessibilityIdentifier("report text")
        } footer: {
          Text("Say what you did, and what you expected. The game you're in is sent with it.")
        }
        Section {
          TextField("Email or name (optional)", text: $contact)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        } footer: {
          Text("Only if you'd like an answer.")
        }
        if let screenshot = report.screenshot, let image = UIImage(data: screenshot) {
          Section {
            Toggle("Include a screenshot", isOn: $withScreenshot)
            if withScreenshot {
              Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 220).frame(maxWidth: .infinity)
            }
          }
        }
        if let failure {
          Section { Text(failure).foregroundStyle(.red) }
        }
      }
      .navigationTitle("Report a problem")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(sending ? "Sending…" : "Send") { Task { await send() } }
            .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
  }

  private func send() async {
    sending = true
    failure = nil
    defer { sending = false }
    var body: [String: Any] = [
      "text": text,
      "contact": contact,
      "name": name.isEmpty ? "Player" : name,
      "client": Analytics.shared.installId,
      "app": ["version": AppInfo.version, "build": AppInfo.build, "device": AppInfo.device],
      "context": game.reportContext(),
    ]
    if withScreenshot, let screenshot = report.screenshot { body["screenshot"] = screenshot.base64EncodedString() }
    do {
      var request = URLRequest(url: OnlineServer.known[0].reports)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      let (data, response) = try await URLSession.shared.data(for: request)
      if (response as? HTTPURLResponse)?.statusCode == 200 {
        game.notice = "Thanks: your report was sent."
        dismiss()
      } else {
        failure = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String ?? "It wasn't sent. Please try again."
      }
    } catch {
      failure = "It wasn't sent (\(error.localizedDescription)). Please try again."
    }
  }
}
