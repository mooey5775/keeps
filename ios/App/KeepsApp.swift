import SwiftUI
import WebKit

/// Keeps: the card game, offline against Midstrike. (Milestone 2: the core runs and plays; the table comes next.)
@main
struct KeepsApp: App {
  @State private var core: Core?
  @State private var status = "Starting…"

  var body: some Scene {
    WindowGroup {
      VStack(spacing: 12) {
        Text("Keeps").font(.largeTitle)
        Text(status).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
      .padding()
      // The core's web view, in the window but unseen: a page that isn't in one runs slowly, or not at all.
      .background {
        if let core { CoreView(core: core).frame(width: 1, height: 1).opacity(0.01) }
      }
      .task { await start() }
    }
  }

  private func start() async {
    do {
      let core = try Core()
      self.core = core
      let ready = try await core.start()
      status = "Core ready: \(ready["network"] ?? "?"), \(ready["workers"] ?? "?") search workers"
      print(status)
      fflush(stdout)
      if ProcessInfo.processInfo.environment["KEEPS_SELFTEST"] != nil {
        UIApplication.shared.isIdleTimerDisabled = true
        let games = (ProcessInfo.processInfo.environment["KEEPS_SELFTEST_GAMES"] ?? "hard:1,easy:1").split(separator: ",").map { spec in
          let parts = spec.split(separator: ":")
          return (level: String(parts[0]), marks: Int(parts.count > 1 ? parts[1] : "1") ?? 1)
        }
        core.configure(botDelayMs: 0)
        status = "Self-test running…"
        await SelfTest(core: core).run(games)
        status = "Self-test done"
      }
    } catch {
      status = "The core failed: \(error)"
      print("FAILED: \(error)\nDONE")
      fflush(stdout)
    }
  }
}

/// The core's web view, placed in the window (it's never meant to be seen).
struct CoreView: UIViewRepresentable {
  let core: Core

  func makeUIView(context: Context) -> WKWebView { core.webView }
  func updateUIView(_ view: WKWebView, context: Context) {}
}
