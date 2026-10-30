import Foundation
import WebKit

/// The web view the spike's page runs in: served from the app bundle through keeps://app/, its log lines printed
/// to stdout (`devicectl device process launch --console` streams them).
enum WebHost {
  static func make() throws -> WKWebView {
    let root = Bundle.main.url(forResource: "web", withExtension: nil)!
    let scheme = SchemeHandler(root: root, inference: try Inference())
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(scheme, forURLScheme: "keeps")
    config.userContentController.add(LogHandler(), name: "log")
    let view = WKWebView(frame: .zero, configuration: config)
    view.isInspectable = true
    // SPIKE_QUERY (a launch environment variable) changes the page's plan, e.g. "positions=4&worlds=256".
    let query = ProcessInfo.processInfo.environment["SPIKE_QUERY"].map { "?" + $0 } ?? ""
    view.load(URLRequest(url: URL(string: "keeps://app/index.html" + query)!))
    return view
  }
}

final class LogHandler: NSObject, WKScriptMessageHandler {
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let line = message.body as? String else { return }
    print(line)
    fflush(stdout)
  }
}
