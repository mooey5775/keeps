import XCTest

/// The generated Swift types (ios/Shared/Protocol.swift) against what the core really says: every message of whole
/// games, both ways (ios/tools/swift-types/goldens.ts recorded them through the core's own bridge), decodes into the
/// types and encodes back to the same JSON. A field the types lack, or have wrong, or absent where it should be null
/// (or the other way), fails here.
final class ProtocolTests: XCTestCase {
  private func lines(_ name: String) throws -> [String] {
    let bundle = Bundle(for: ProtocolTests.self)
    let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "jsonl", subdirectory: "goldens"), "\(name).jsonl isn't in the test bundle")
    return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map(String.init)
  }

  /// Decodes each line as T, encodes it back, and compares the two as JSON values.
  private func roundTrip<T: Codable>(_ type: T.Type, _ name: String) throws -> Int {
    var checked = 0
    for (i, line) in try lines(name).enumerated() {
      let data = Data(line.utf8)
      let value: T
      do {
        value = try JSONDecoder().decode(T.self, from: data)
      } catch {
        XCTFail("\(name) line \(i + 1) doesn't decode as \(T.self): \(error)\n\(line.prefix(600))")
        continue
      }
      let again = try JSONEncoder().encode(value)
      let original = try JSONSerialization.jsonObject(with: data)
      let encoded = try JSONSerialization.jsonObject(with: again)
      if !same(original, encoded) {
        XCTFail("\(name) line \(i + 1) encodes back differently:\n\(firstDifference(original, encoded, path: ""))")
      }
      checked += 1
    }
    return checked
  }

  /// Two JSON values alike. Numbers may differ by a few units in the last place: Foundation's JSON decoder rounds some
  /// long fixed-point decimals (0.000049625363535921174, as JavaScript writes 4.9625363535921174e-5) to the next double.
  private func same(_ a: Any?, _ b: Any?) -> Bool {
    switch (a, b) {
    case let (a as [String: Any], b as [String: Any]):
      return Set(a.keys) == Set(b.keys) && a.allSatisfy { same($0.value, b[$0.key]) }
    case let (a as [Any], b as [Any]):
      return a.count == b.count && zip(a, b).allSatisfy { same($0, $1) }
    case let (a as NSNumber, b as NSNumber):
      let boolean = { (n: NSNumber) in CFGetTypeID(n) == CFBooleanGetTypeID() }
      if boolean(a) || boolean(b) { return boolean(a) && boolean(b) && a.boolValue == b.boolValue }
      let x = a.doubleValue, y = b.doubleValue
      return x == y || abs(x - y) <= max(abs(x), abs(y)) * 4 * Double.ulpOfOne
    case let (a as String, b as String):
      return a == b
    case (is NSNull, is NSNull), (nil, nil):
      return true
    default:
      return false
    }
  }

  /// Where two JSON values first differ, for the failure message.
  private func firstDifference(_ a: Any?, _ b: Any?, path: String) -> String {
    switch (a, b) {
    case let (a as [String: Any], b as [String: Any]):
      for key in Set(a.keys).union(b.keys).sorted() where !same(a[key], b[key]) {
        return firstDifference(a[key], b[key], path: "\(path).\(key)")
      }
    case let (a as [Any], b as [Any]):
      if a.count != b.count { return "\(path): \(a.count) elements, encoded back as \(b.count)" }
      for (i, (x, y)) in zip(a, b).enumerated() where !same(x, y) {
        return firstDifference(x, y, path: "\(path)[\(i)]")
      }
    default:
      break
    }
    return "\(path): \(a.map { "\($0)" } ?? "absent") vs \(b.map { "\($0)" } ?? "absent")"
  }

  func testEveryMessageTheCoreSendsRoundTrips() throws {
    XCTAssertGreaterThan(try roundTrip(ToApp.self, "to-app"), 100)
  }

  func testEveryMessageTheAppSendsRoundTrips() throws {
    XCTAssertGreaterThan(try roundTrip(FromApp.self, "from-app"), 50)
  }

  func testTheTypesSayWhatTheMessagesHold() throws {
    // A few things the app will lean on, checked by value (not only by surviving a round trip).
    var games = 0
    for line in try lines("to-app") {
      guard case .server(let envelope) = try JSONDecoder().decode(ToApp.self, from: Data(line.utf8)), case .game(let game) = envelope.message else { continue }
      games += 1
      let view = game.view
      XCTAssertEqual(view.piles.count, 4)
      if case .number(let seat) = view.viewer, view.prompts.contains(where: { if case .mine = $0 { return true } else { return false } }) {
        XCTAssertTrue((0...3).contains(seat))
        // The options cover the legal moves, one each.
        XCTAssertEqual(envelope.options?.count, view.legal.count)
      }
      XCTAssertNotNil(envelope.lines)
    }
    XCTAssertGreaterThan(games, 50)
  }
}
