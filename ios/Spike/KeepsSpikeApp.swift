import SwiftUI
import WebKit

/// The spike: a page (ios/web) that runs Midstrike's search in JavaScript workers, the network in Core ML.
@main
struct KeepsSpikeApp: App {
  var body: some Scene {
    WindowGroup {
      SpikeView()
        .ignoresSafeArea()
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }  // benchmarks run for minutes
    }
  }
}

struct SpikeView: UIViewRepresentable {
  func makeUIView(context: Context) -> WKWebView {
    do {
      return try WebHost.make()
    } catch {
      print("FAILED: \(error)\nDONE")
      let view = WKWebView()
      view.loadHTMLString("<pre>\(error)</pre>", baseURL: nil)
      return view
    }
  }

  func updateUIView(_ view: WKWebView, context: Context) {}
}
