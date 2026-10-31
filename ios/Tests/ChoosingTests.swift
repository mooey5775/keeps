import XCTest

/// Choosing a move by touching the table (ios/Shared/Choosing.swift) against the TypeScript it ports
/// (web/src/game/options.ts): on the options of whole games, touches with what each did there, what was worth
/// touching before it, and the panel's buttons (ios/tools/swift-types/goldens.ts recorded them). Swift must answer
/// every one the same.
final class ChoosingTests: XCTestCase {
  private struct Case: Decodable {
    struct PanelItem: Decodable, Equatable {
      var kind: String
      var label: String
      var ref: String?
      var count: Int?
    }
    struct Result: Decodable {
      var kind: String
      var command: Command?
      var picked: [String]?
    }
    var options: [Option]
    var picked: [String]
    var ref: String
    var clickable: [String]
    var panel: [PanelItem]
    var result: Result
  }

  func testTouchesDoWhatTheyDoInTheWebClient() throws {
    let bundle = Bundle(for: ChoosingTests.self)
    let url = try XCTUnwrap(bundle.url(forResource: "choosing", withExtension: "jsonl", subdirectory: "goldens"))
    let lines = try String(contentsOf: url, encoding: .utf8).split(separator: "\n")
    var sends = 0
    var groups = 0
    for (i, line) in lines.enumerated() {
      let c = try JSONDecoder().decode(Case.self, from: Data(line.utf8))
      let at = "case \(i + 1) (touching \(c.ref) after \(c.picked))"
      XCTAssertEqual(Choosing.touchable(c.options, c.picked).sorted(), c.clickable, "\(at): what lights up")
      let panel = Choosing.panelItems(c.options, c.picked).map { item -> Case.PanelItem in
        switch item {
        case .option(let option): return .init(kind: "option", label: option.label)
        case .group(let ref, let label, let count): return .init(kind: "group", label: label, ref: ref, count: count)
        }
      }
      XCTAssertEqual(panel, c.panel, "\(at): the panel")
      groups += panel.filter { $0.kind == "group" }.count
      switch (Choosing.touch(c.options, c.picked, c.ref), c.result.kind) {
      case (.send(let command), "send"):
        XCTAssertEqual(command, c.result.command, "\(at): the move")
        sends += 1
      case (.pick(let picked), "pick"): XCTAssertEqual(picked, c.result.picked, "\(at): what's picked")
      case (.ignore, "ignore"): break
      case (let swift, let ts): XCTFail("\(at): Swift says \(swift), the web client \(ts)")
      }
    }
    XCTAssertGreaterThan(lines.count, 100)
    XCTAssertGreaterThan(sends, 20)
    XCTAssertGreaterThan(groups, 0, "no case has grouped panel buttons")
  }
}
