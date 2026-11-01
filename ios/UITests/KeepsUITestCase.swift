import XCTest

/// What the app's UI tests share: launching the app (into a game against Easy Midstrike, on a fixed deal, or online on
/// the test server), and finding the table's elements. The tests are in classes of their own (TableUITests,
/// LifecycleUITests, OnlineUITests), so ios/test.sh runs them side by side, each class on a simulator of its own.
class KeepsUITestCase: XCTestCase {
  var app: XCUIApplication!

  /// Fixed deals, so each test plays the same game every time (whichever seat you get):
  /// - ui-7: your first three draws aren't HOT, and are played on their own (Epiphany, Prayer, Providence; or
  ///   Requisition, Legerdemain, Scepter);
  /// - ui-keep-3: your first draw is a Keep card, played into a keep (Retribution; or Scepter);
  /// - ui-hot-43: your first draw is HOT, and so is your second (Acquisition), with the first in your keep (found by
  ///   drawing every move in the core's server, as the app runs it, over seeds);
  /// - ui-tithes-2: your first draw is Tithes (found the same way).
  enum Deal: String {
    case alone = "ui-7"
    case keep = "ui-keep-3"
    case hotTwice = "ui-hot-43"
    case tithes = "ui-tithes-2"
  }

  /// The app, with Midstrike quick to move (150 ms, not the 900 a person needs to follow it: the tests wait on it often).
  func newApp() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["KEEPS_BOT_DELAY"] = "150"
    return app
  }

  override func setUp() {
    continueAfterFailure = false
  }

  func launch(_ deal: Deal = .alone, lag: Int = 0) {
    app = newApp()
    app.launchEnvironment["KEEPS_PLAY"] = "easy:5"
    app.launchEnvironment["KEEPS_SEED"] = deal.rawValue
    if lag > 0 { app.launchEnvironment["KEEPS_LAG"] = String(lag) }
    app.launch()
  }

  /// The element called `name` (its identifier, the table's ref, or its label); the first, when the card's views share it.
  func element(_ name: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ OR label == %@", name, name)).firstMatch
  }

  var handCards: [XCUIElement] {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'hand:'")).allElementsBoundByIndex
  }

  /// Whether `element` is gone within `seconds`.
  func gone(_ element: XCUIElement, within seconds: TimeInterval) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
    return XCTWaiter().wait(for: [expectation], timeout: seconds) == .completed
  }

  /// The panel's move putting a HOT card into your keep (its label also names the card pictured on it).
  var putIntoYourKeep: XCUIElement {
    app.buttons.matching(NSPredicate(format: "label CONTAINS 'Put ' AND label CONTAINS 'into your keep'")).firstMatch
  }

  /// Answers a HOT card's prompt, if one is open (the card drawn may be HOT): into your keep.
  func placeHot() {
    if putIntoYourKeep.waitForExistence(timeout: 1) { putIntoYourKeep.tap() }
  }

  /// Waits for your turn (the panel offers to draw), up to `seconds`.
  func yourTurn(_ seconds: TimeInterval = 30) -> Bool { app.buttons["Draw from your pile"].waitForExistence(timeout: seconds) }

  /// Your pile, as the table names it ("Your pile, 9 cards").
  var yourPile: XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Your pile'")).firstMatch
  }

  /// Waits up to `seconds` for `condition`.
  func eventually(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    return condition()
  }

  /// The cards in your keep.
  var yourKeepCards: [XCUIElement] {
    element("Your keep").descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'keepcard:'")).allElementsBoundByIndex
  }

  // MARK: Online (ios/tools/test-server.ts, which ios/test.sh runs and forwards to the Mac)

  static let testServer = "ws://localhost:7777/ws"

  /// The app with the test server as its online server, at the lobby (not straight into a game).
  func launchOnline() {
    app = newApp()
    app.launchEnvironment["KEEPS_SERVER"] = Self.testServer
    app.launch()
    let online = app.buttons["Online"]
    XCTAssertTrue(online.waitForExistence(timeout: 30), "no lobby")
    online.tap()
  }

  /// A game an earlier test left the phone holding (it holds one at a time), left when the lobby asks: going on.
  func leaveWhatsHeld() {
    let go = app.buttons["Leave it and go on"]
    if go.waitForExistence(timeout: 2) { go.tap() }
  }

  /// A room made online with Midstrike in it, and the game started: its code.
  func startOnlineGameAgainstMidstrike() -> String {
    app.buttons["Make a room"].tap()
    leaveWhatsHeld()
    let code = app.staticTexts["room's code"]
    XCTAssertTrue(code.waitForExistence(timeout: 15), "no room")
    let name = code.label
    XCTAssertEqual(name.count, 4)
    app.buttons["Add Midstrike"].tap()
    XCTAssertTrue(app.buttons["Remove Midstrike"].waitForExistence(timeout: 5), "Midstrike didn't join")
    app.buttons["Start"].tap()
    XCTAssertTrue(eventually(15) { self.yourPile.exists }, "no table")
    return name
  }

  /// Seats `players` scripted players in room `code` on the test server (they play any legal move on their turns).
  func fill(_ code: String, players: Int) {
    testServer("fill?code=\(code)&players=\(players)")
  }

  /// Asks the test server's test page `path` (/test/...).
  func testServer(_ path: String) {
    let url = URL(string: "http://localhost:7777/test/\(path)")!
    let done = expectation(description: "seated")
    URLSession.shared.dataTask(with: url) { _, response, _ in
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 10)
  }

  /// A room online with `others` scripted players, started: every player's seat on the table, and your turn playable.
  /// Returns the room's code.
  @discardableResult
  func playOnlineWith(others: Int) -> String {
    launchOnline()
    app.buttons["Make a room"].tap()
    leaveWhatsHeld()
    let codeText = app.staticTexts["room's code"]
    XCTAssertTrue(codeText.waitForExistence(timeout: 15), "no room")
    let code = codeText.label
    fill(code, players: others)
    XCTAssertTrue(app.staticTexts["Players (\(others + 1) of 4)"].waitForExistence(timeout: 10), "the players didn't join")
    app.buttons["Start"].tap()
    XCTAssertTrue(eventually(15) { self.yourPile.exists }, "no table")
    // Each player at the table, with their keep: not only the one across from you.
    for i in 1...others {
      XCTAssertTrue(element("Robot \(i)'s keep").waitForExistence(timeout: 5), "Robot \(i) has no seat at the table")
    }
    XCTAssertTrue(element("Your keep").exists)
    // A decision of yours comes (with more players, not always a draw: another's Fiat has you claim a pile).
    XCTAssertTrue(app.buttons["All moves"].waitForExistence(timeout: 60), "no decision of yours came")
    return code
  }
}
