import Foundation
import WebKit

/// keeps://app/: the bundled page and its files, and the network:
///   POST nn/forward  observations (inference protocol, packages/learn/demo/inference.ts) → float32 logits
///   POST nn/echo     the same request answered with zeros, without the network (the bridge's own cost)
///   GET  nn/info     the model's metadata (its network's fingerprint and step) and the device's cores
///   GET  nn/stats    where the requests' time went since the last call (JSON)
///   GET  nn/bench    Core ML's own speed, by compute units and batch size
///   GET  nn/units?set=ane|gpu|cpu|all  which compute units the model runs on from now
final class SchemeHandler: NSObject, WKURLSchemeHandler {
  private let root: URL
  private let inference: Inference
  /// Requests run at once, up to Inference.lanes of them (the rest wait for a lane).
  private let queue = DispatchQueue(label: "keeps.inference", qos: .userInitiated, attributes: .concurrent)
  /// Tasks still wanted (WebKit throws if a stopped task is answered). Main thread only.
  private var live = Set<ObjectIdentifier>()

  init(root: URL, inference: Inference) {
    self.root = root
    self.inference = inference
  }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    live.insert(ObjectIdentifier(task))
    let request = task.request
    guard let url = request.url else { return finish(task, .failure(KeepsError("no URL"))) }
    let inference = self.inference
    switch url.path {
    case "/nn/forward", "/nn/echo":
      let body = Self.body(of: request)
      let echo = url.path == "/nn/echo"
      queue.async {
        let result = Result { echo ? try inference.echo(body) : try inference.forward(body) }
        DispatchQueue.main.async { self.finish(task, result, type: "application/octet-stream") }
      }
    case "/nn/info":
      let info = inference.metadata.merging(Cores.current.info) { a, _ in a }
      finish(task, Result { try JSONSerialization.data(withJSONObject: info) }, type: "application/json")
    case "/nn/stats":
      finish(task, Result { try inference.takeTimes() }, type: "application/json")
    case "/nn/bench":
      queue.async {
        let result = Result { Data(try inference.bench().utf8) }
        DispatchQueue.main.async { self.finish(task, result, type: "text/plain") }
      }
    case "/nn/units":
      let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "set" }?.value ?? "ane"
      queue.async {
        let result = Result { try inference.setUnits(name); return Data("ok".utf8) }
        DispatchQueue.main.async { self.finish(task, result, type: "text/plain") }
      }
    default:
      let file = root.appendingPathComponent(String(url.path.dropFirst()))
      guard file.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path) else {
        return finish(task, .failure(KeepsError("outside the page: \(url.path)")))
      }
      finish(task, Result { try Data(contentsOf: file) }, type: Self.mime(file.pathExtension))
    }
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    live.remove(ObjectIdentifier(task))
  }

  private func finish(_ task: WKURLSchemeTask, _ result: Result<Data, Error>, type: String = "text/plain") {
    guard live.remove(ObjectIdentifier(task)) != nil, let url = task.request.url else { return }
    let (status, data, contentType) = switch result {
    case .success(let data): (200, data, type)
    case .failure(let error): (500, Data("\(error)".utf8), "text/plain")
    }
    let headers = ["Content-Type": contentType, "Content-Length": String(data.count), "Cache-Control": "no-store"]
    task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
    task.didReceive(data)
    task.didFinish()
  }

  /// A request's body: WebKit hands it over as data or as a stream.
  private static func body(of request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: 1 << 16)
    stream.open()
    defer { stream.close() }
    while true {
      let n = stream.read(&chunk, maxLength: chunk.count)
      if n <= 0 { break }
      data.append(chunk, count: n)
    }
    return data
  }

  private static func mime(_ ext: String) -> String {
    switch ext {
    case "html": "text/html"
    case "js", "mjs": "text/javascript"
    case "json", "map": "application/json"
    case "css": "text/css"
    default: "application/octet-stream"
    }
  }
}

struct KeepsError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// The device's CPU cores: all of them (WebKit's navigator.hardwareConcurrency reports fewer), and how many are
/// performance and efficiency cores (Apple's perflevel0 and perflevel1).
struct Cores {
  let all: Int, performance: Int, efficiency: Int

  static let current = Cores(
    all: ProcessInfo.processInfo.activeProcessorCount,
    performance: sysctl("hw.perflevel0.logicalcpu") ?? ProcessInfo.processInfo.activeProcessorCount,
    efficiency: sysctl("hw.perflevel1.logicalcpu") ?? 0)

  var info: [String: String] { ["cores": String(all), "performanceCores": String(performance), "efficiencyCores": String(efficiency)] }

  private static func sysctl(_ name: String) -> Int? {
    var value: Int32 = 0
    var size = MemoryLayout<Int32>.size
    return sysctlbyname(name, &value, &size, nil, 0) == 0 ? Int(value) : nil
  }
}
