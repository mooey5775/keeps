import XCTest

/// The table, used as a person would: a game against Easy Midstrike, your cards picked up from your hand and let go
/// where they go. (The moves themselves are the core's; here, what's checked is that carrying a card makes one.)
final class TableUITests: XCTestCase {
  private var app: XCUIApplication!

  /// Fixed deals, so each test plays the same game every time (whichever seat you get):
  /// - ui-7: your first three draws aren't HOT, and are played on their own (Epiphany, Prayer, Providence; or
  ///   Requisition, Legerdemain, Scepter);
  /// - ui-keep-3: your first draw is a Keep card, played into a keep (Retribution; or Scepter);
  /// - ui-hot-43: your first draw is HOT, and so is your second (Acquisition), with the first in your keep (found by
  ///   drawing every move in the core's server, as the app runs it, over seeds).
  private enum Deal: String {
    case alone = "ui-7"
    case keep = "ui-keep-3"
    case hotTwice = "ui-hot-43"
  }

  override func setUp() {
    continueAfterFailure = false
  }

  private func launch(_ deal: Deal = .alone, lag: Int = 0) {
    app = XCUIApplication()
    app.launchEnvironment["KEEPS_PLAY"] = "easy:5"
    app.launchEnvironment["KEEPS_SEED"] = deal.rawValue
    if lag > 0 { app.launchEnvironment["KEEPS_LAG"] = String(lag) }
    app.launch()
  }

  /// The element called `name` (its identifier, the table's ref, or its label); the first, when the card's views share it.
  private func element(_ name: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ OR label == %@", name, name)).firstMatch
  }

  private var handCards: [XCUIElement] {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'hand:'")).allElementsBoundByIndex
  }

  /// Whether `element` is gone within `seconds`.
  private func gone(_ element: XCUIElement, within seconds: TimeInterval) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
    return XCTWaiter().wait(for: [expectation], timeout: seconds) == .completed
  }

  /// The panel's move putting a HOT card into your keep (its label also names the card pictured on it).
  private var putIntoYourKeep: XCUIElement {
    app.buttons.matching(NSPredicate(format: "label CONTAINS 'Put ' AND label CONTAINS 'into your keep'")).firstMatch
  }

  /// Answers a HOT card's prompt, if one is open (the card drawn may be HOT): into your keep.
  private func placeHot() {
    if putIntoYourKeep.waitForExistence(timeout: 1) { putIntoYourKeep.tap() }
  }

  /// Waits for your turn (the panel offers to draw), up to `seconds`.
  private func yourTurn(_ seconds: TimeInterval = 30) -> Bool { app.buttons["Draw from your pile"].waitForExistence(timeout: seconds) }

  func testACardCarriedToWhereItGoesMakesTheMove() throws {
    launch()
    var carried = 0
    for _ in 0..<30 where carried < 2 {
      guard yourTurn() else { break }
      // A card from your hand to your keep, the table's middle (played alone), or Midstrike's keep: one of them takes it.
      guard let card = handCards.first(where: { $0.isHittable }) else {
        app.buttons["Draw from your pile"].tap()
        continue
      }
      let id = card.identifier
      for place in ["Your keep", "table", "Midstrike's keep"] {
        let target = element(place)
        guard target.exists, element(id).exists else { continue }
        element(id).press(forDuration: 0.12, thenDragTo: target)
        if gone(element(id), within: 2) {
          carried += 1
          break
        }
      }
      if element(id).exists, app.buttons["Draw from your pile"].exists { app.buttons["Draw from your pile"].tap() }
    }
    XCTAssertGreaterThan(carried, 0, "no card carried from the hand made a move")
  }

  /// Your pile, as the table names it ("Your pile, 9 cards").
  private var yourPile: XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Your pile'")).firstMatch
  }

  /// Waits up to `seconds` for `condition`.
  private func eventually(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    return condition()
  }

  func testTouchingYourPileDraws() throws {
    launch()
    XCTAssertTrue(yourTurn())
    let before = handCards.count
    yourPile.tap()
    XCTAssertTrue(eventually(5) { handCards.count > before }, "touching your pile drew no card")
  }

  func testHoldingACardOnlyShowsItAndTouchingItChoosesIt() throws {
    launch()
    XCTAssertTrue(yourTurn())
    yourPile.tap()
    placeHot()
    // Your turn, with a card in hand (drawing again if the first was HOT and went into your keep).
    for _ in 0..<6 where !handCards.contains(where: { $0.isHittable }) {
      XCTAssertTrue(yourTurn(30))
      yourPile.tap()
      placeHot()
    }
    XCTAssertTrue(yourTurn(30))
    XCTAssertTrue(handCards.contains { $0.isHittable })
    let card = handCards.first { $0.isHittable }!
    let id = card.identifier
    card.press(forDuration: 1.2)
    // Held, then let go: shown, and nothing else (not picked, not played).
    XCTAssertTrue(element(id).exists, "holding the card played it")
    XCTAssertFalse(app.buttons["Cancel selection"].exists, "holding the card picked it")
    // Touched: picked (a move that needs more), or played.
    element(id).tap()
    XCTAssertTrue(eventually(5) { app.buttons["Cancel selection"].exists || !self.element(id).exists }, "touching the card did nothing")
  }

  func testMovingAFingerWhileACardIsShownCarriesNothing() throws {
    launch()
    XCTAssertTrue(yourTurn())
    yourPile.tap()
    placeHot()
    for _ in 0..<6 where !handCards.contains(where: { $0.isHittable }) {
      XCTAssertTrue(yourTurn(30))
      yourPile.tap()
      placeHot()
    }
    XCTAssertTrue(yourTurn(30))
    XCTAssertTrue(handCards.contains { $0.isHittable })
    let card = handCards.first { $0.isHittable }!
    let id = card.identifier
    // Held until shown, then moved onto the table's middle (where it would be played) and let go: it was only being
    // looked at.
    card.press(forDuration: 1.0, thenDragTo: element("table"))
    XCTAssertTrue(element(id).exists, "the card was carried after it was shown")
    XCTAssertFalse(app.buttons["Cancel selection"].exists)
  }

  func testACardCarriedIntoYourKeepGoesThere() throws {
    launch(.keep)
    XCTAssertTrue(yourTurn())
    yourPile.tap()
    XCTAssertTrue(eventually(5) { handCards.contains { $0.isHittable } }, "no card drawn")
    let drawn = handCards.first { $0.isHittable }!
    let id = drawn.identifier
    let name = drawn.label
    // A Keep card, carried onto your keep (and nowhere else): it leaves your hand for your keep.
    drawn.press(forDuration: 0.12, thenDragTo: element("Your keep"))
    XCTAssertTrue(gone(element(id), within: 3), "the Keep card carried onto your keep stayed in your hand")
    let keepCard = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'keepcard:' AND label == %@", name)).firstMatch
    XCTAssertTrue(keepCard.waitForExistence(timeout: 3), "the card isn't in a keep")
  }

  func testAMoveTouchedTwiceIsMadeOnce() throws {
    // (The game's answers held 2 s, as on a very slow phone: the second touch comes before the table moves on.)
    launch(lag: 2000)
    XCTAssertTrue(yourTurn())
    let before = handCards.count
    // Two touches on the panel's move before the table moves on: one draw, and no complaint.
    let draw = app.buttons["Draw from your pile"]
    draw.tap()
    draw.tap()
    XCTAssertTrue(eventually(8) { handCards.count > before }, "the move wasn't made")
    XCTAssertFalse(app.alerts["Something went wrong"].waitForExistence(timeout: 2), "the move was sent twice")
    XCTAssertEqual(handCards.count, before + 1, "the move was made twice")
  }

  /// The cards in your keep.
  private var yourKeepCards: [XCUIElement] {
    element("Your keep").descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'keepcard:'")).allElementsBoundByIndex
  }

  func testTouchingACardInYourKeepChoosesYourKeep() throws {
    launch(.hotTwice)
    // Drawing: the first HOT card goes into your keep from the panel; the second goes there by touching the card in it
    // (a full keep is all cards: the touch is for the keep).
    let put = putIntoYourKeep
    for _ in 0..<8 {
      XCTAssertTrue(eventually(40) { put.exists || self.app.buttons["Draw from your pile"].exists })
      guard put.exists else {
        yourPile.tap()
        _ = put.waitForExistence(timeout: 3)
        continue
      }
      let before = yourKeepCards.count
      guard before > 0 else {
        put.tap()
        continue
      }
      yourKeepCards.first!.tap()
      XCTAssertTrue(eventually(5) { yourKeepCards.count == before + 1 }, "touching a card in your keep didn't put the HOT card there")
      return
    }
    XCTFail("no HOT card came with a card in your keep")
  }

  func testAGameIsTakenUpAgainAfterTheAppCloses() throws {
    launch()
    XCTAssertTrue(yourTurn())
    yourPile.tap()
    placeHot()
    XCTAssertTrue(yourTurn(40))
    yourPile.tap()
    placeHot()
    XCTAssertTrue(eventually(5) { !handCards.isEmpty })
    let hand = handCards.map(\.identifier).sorted()
    // Closed, opened again (not straight into a game): the lobby offers the game, and it's as it was.
    app.terminate()
    app.launchEnvironment["KEEPS_PLAY"] = nil
    app.launch()
    // (The lobby remembers where you last played: here, on this phone.)
    let here = app.buttons["On this phone"]
    XCTAssertTrue(here.waitForExistence(timeout: 30))
    here.tap()
    let resume = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Continue'")).firstMatch
    XCTAssertTrue(resume.waitForExistence(timeout: 30), "the lobby doesn't offer the game")
    resume.tap()
    XCTAssertTrue(eventually(10) { handCards.map(\.identifier).sorted() == hand }, "the hand isn't as it was")
    // And it plays on.
    XCTAssertTrue(yourTurn(40) || app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Play '")).firstMatch.exists)
  }

  func testAGameGoesOnWhenTheCoresProcessEnds() throws {
    app = XCUIApplication()
    app.launchEnvironment["KEEPS_PLAY"] = "easy:5"
    app.launchEnvironment["KEEPS_SEED"] = Deal.alone.rawValue
    app.launchEnvironment["KEEPS_TEST_HOOKS"] = "1"
    app.launch()
    XCTAssertTrue(yourTurn())
    yourPile.tap()
    placeHot()
    XCTAssertTrue(eventually(5) { !handCards.isEmpty })
    let hand = handCards.map(\.identifier).sorted()
    // The core's process ended (as iOS ends it, to free memory): the core starts again, and the game with it.
    app.buttons["Game menu"].tap()
    app.buttons["End the core's process"].tap()
    XCTAssertTrue(eventually(10) { handCards.isEmpty }, "the table stayed as if the game were still there")
    XCTAssertTrue(eventually(30) { handCards.map(\.identifier).sorted() == hand && self.app.buttons["Draw from your pile"].exists }, "the game didn't come back as it was")
    XCTAssertFalse(app.alerts["Something went wrong"].exists)
    yourPile.tap()
    XCTAssertTrue(eventually(5) { handCards.count > hand.count }, "the game doesn't go on")
  }

  func testYourPileCarriedToYourHandDraws() throws {
    launch()
    XCTAssertTrue(yourTurn())
    let before = handCards.count
    yourPile.press(forDuration: 0.12, thenDragTo: element("Your hand"))
    XCTAssertTrue(eventually(5) { handCards.count > before }, "carrying your pile to your hand drew no card")
  }

  // MARK: Online (ios/tools/test-server.ts, which ios/test.sh runs and forwards to the Mac)

  private static let testServer = "ws://localhost:7777/ws"

  /// The app with the test server as its online server, at the lobby (not straight into a game).
  private func launchOnline() {
    app = XCUIApplication()
    app.launchEnvironment["KEEPS_SERVER"] = Self.testServer
    app.launch()
    let online = app.buttons["Online"]
    XCTAssertTrue(online.waitForExistence(timeout: 30), "no lobby")
    online.tap()
  }

  /// A room made online with Midstrike in it, and the game started: its code.
  private func startOnlineGameAgainstMidstrike() -> String {
    app.buttons["Make a room"].tap()
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

  func testAnOnlineRoomIsMadeAndPlayedAgainstMidstrike() throws {
    launchOnline()
    _ = startOnlineGameAgainstMidstrike()
    // Your turn comes (Midstrike's first, if it starts), and your move is made there.
    XCTAssertTrue(yourTurn(40))
    let before = handCards.count
    yourPile.tap()
    XCTAssertTrue(eventually(10) { self.handCards.count > before || self.putIntoYourKeep.exists }, "the move online wasn't made")
    XCTAssertFalse(app.alerts["Something went wrong"].exists)
  }

  func testAnOnlineSeatIsTakenBackAfterTheAppCloses() throws {
    launchOnline()
    let code = startOnlineGameAgainstMidstrike()
    // Drawing until a card stays in your hand (a HOT one goes into your keep; the deal online is the server's).
    for _ in 0..<6 where handCards.isEmpty {
      XCTAssertTrue(yourTurn(40))
      yourPile.tap()
      placeHot()
      _ = eventually(3) { !self.handCards.isEmpty }
    }
    XCTAssertFalse(handCards.isEmpty, "no card stayed in your hand")
    let hand = handCards.map(\.identifier).sorted()
    app.terminate()
    app.launch()
    let online = app.buttons["Online"]
    XCTAssertTrue(online.waitForExistence(timeout: 30))
    online.tap()
    let back = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Back to \(code)")).firstMatch
    XCTAssertTrue(back.waitForExistence(timeout: 5), "the lobby doesn't offer the room")
    back.tap()
    XCTAssertTrue(eventually(15) { self.handCards.map(\.identifier).sorted() == hand }, "the seat wasn't taken back as it was")
  }

  func testJoiningARoomThatIsntThereSaysSo() throws {
    launchOnline()
    let field = app.textFields["room code"]
    field.tap()
    field.typeText("zzzz")
    app.buttons["Join"].tap()
    let alert = app.alerts["Something went wrong"]
    XCTAssertTrue(alert.waitForExistence(timeout: 10), "joining a room that isn't there said nothing")
    XCTAssertTrue(alert.staticTexts.matching(NSPredicate(format: "label CONTAINS 'ZZZZ'")).firstMatch.exists)
  }

  /// Seats `players` scripted players in room `code` on the test server (they play any legal move on their turns).
  private func fill(_ code: String, players: Int) {
    let url = URL(string: "http://localhost:7777/test/fill?code=\(code)&players=\(players)")!
    let done = expectation(description: "seated")
    URLSession.shared.dataTask(with: url) { _, response, _ in
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 10)
  }

  /// A room online with `others` scripted players, started: every player's seat on the table, and your turn playable.
  private func playOnlineWith(others: Int) {
    launchOnline()
    app.buttons["Make a room"].tap()
    let code = app.staticTexts["room's code"]
    XCTAssertTrue(code.waitForExistence(timeout: 15), "no room")
    fill(code.label, players: others)
    XCTAssertTrue(app.staticTexts["Players (\(others + 1) of 4)"].waitForExistence(timeout: 10), "the players didn't join")
    app.buttons["Start"].tap()
    XCTAssertTrue(eventually(15) { self.yourPile.exists }, "no table")
    // Each player at the table, with their keep: not only the one across from you.
    for i in 1...others {
      XCTAssertTrue(element("Robot \(i)'s keep").waitForExistence(timeout: 5), "Robot \(i) has no seat at the table")
    }
    XCTAssertTrue(element("Your keep").exists)
    XCTAssertTrue(yourTurn(60), "your turn didn't come")
    let before = handCards.count
    yourPile.tap()
    XCTAssertTrue(eventually(10) { self.handCards.count > before || self.putIntoYourKeep.exists }, "your move wasn't made")
  }

  func testAGameOfThreeShowsEveryPlayer() throws { playOnlineWith(others: 2) }

  func testAGameOfFourShowsEveryPlayer() throws { playOnlineWith(others: 3) }
}
