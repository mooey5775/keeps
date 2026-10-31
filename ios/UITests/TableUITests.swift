import XCTest

/// The table, used as a person would: a game against Easy Midstrike, your cards picked up from your hand and let go
/// where they go. (The moves themselves are the core's; here, what's checked is that carrying a card makes one.)
final class TableUITests: XCTestCase {
  private var app: XCUIApplication!

  /// Fixed deals, so each test plays the same game every time (whichever seat you get):
  /// - ui-7: your first three draws aren't HOT, and are played on their own (Epiphany, Prayer, Providence; or
  ///   Requisition, Legerdemain, Scepter);
  /// - ui-keep-3: your first draw is a Keep card, played into a keep (Retribution; or Scepter).
  private enum Deal: String {
    case alone = "ui-7"
    case keep = "ui-keep-3"
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

  /// Answers a HOT card's prompt, if one is open (the card drawn may be HOT): into your keep.
  private func placeHot() {
    let put = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Put ' AND label ENDSWITH 'into your keep'")).firstMatch
    if put.waitForExistence(timeout: 1) { put.tap() }
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

  func testYourPileCarriedToYourHandDraws() throws {
    launch()
    XCTAssertTrue(yourTurn())
    let before = handCards.count
    yourPile.press(forDuration: 0.12, thenDragTo: element("Your hand"))
    XCTAssertTrue(eventually(5) { handCards.count > before }, "carrying your pile to your hand drew no card")
  }
}
