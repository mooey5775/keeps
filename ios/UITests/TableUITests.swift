import XCTest

/// The table, used as a person would: a game against Easy Midstrike, your cards picked up from your hand and let go
/// where they go. (The moves themselves are the core's; here, what's checked is that carrying a card makes one.)
final class TableUITests: XCTestCase {
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchEnvironment["KEEPS_PLAY"] = "easy:5"
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

  /// Waits for your turn (the panel offers to draw), up to `seconds`.
  private func yourTurn(_ seconds: TimeInterval = 30) -> Bool { app.buttons["Draw from your pile"].waitForExistence(timeout: seconds) }

  func testACardCarriedToWhereItGoesMakesTheMove() throws {
    var carried = 0
    for _ in 0..<30 where carried < 2 {
      guard yourTurn() else { break }
      // A card from your hand to your keep, the middle (played alone), or Midstrike's keep: one of them takes it.
      guard let card = handCards.first(where: { $0.isHittable }) else {
        app.buttons["Draw from your pile"].tap()
        continue
      }
      let id = card.identifier
      for place in ["Your keep", "middle", "Midstrike's keep"] {
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
    XCTAssertTrue(yourTurn())
    let before = handCards.count
    yourPile.tap()
    XCTAssertTrue(eventually(5) { handCards.count > before }, "touching your pile drew no card")
  }

  func testHoldingACardOnlyShowsItAndTouchingItChoosesIt() throws {
    XCTAssertTrue(yourTurn())
    yourPile.tap()
    XCTAssertTrue(eventually(5) { handCards.contains { $0.isHittable } })
    // Still your turn (one action left): the card you drew is a move to make.
    XCTAssertTrue(yourTurn(10))
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
}
