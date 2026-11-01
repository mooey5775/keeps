import XCTest

/// The table, touched as a person touches it: cards picked up from your hand and let go where they go, held to look at, touched to choose (a game against Easy Midstrike; the moves themselves are the core's: here, what's checked is that carrying a card makes one).
final class TableUITests: KeepsUITestCase {
  func testACardCarriedToWhereItGoesMakesTheMove() throws {
    launch()
    var carried = 0
    for _ in 0..<30 where carried < 1 {
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

  func testYourPileCarriedToYourHandDraws() throws {
    launch()
    XCTAssertTrue(yourTurn())
    let before = handCards.count
    yourPile.press(forDuration: 0.12, thenDragTo: element("Your hand"))
    XCTAssertTrue(eventually(5) { handCards.count > before }, "carrying your pile to your hand drew no card")
  }

  func testTrainingModesHintIsShownOverTithesReorder() throws {
    // The reorder is a sheet over the panel, where the hint is: the sheet shows it too.
    launch(.tithes)
    XCTAssertTrue(yourTurn())
    app.buttons["Game menu"].tap()
    element("Training mode").tap()
    app.buttons["Draw from your pile"].tap()
    let play = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Play Tithes into your keep'")).firstMatch
    XCTAssertTrue(play.waitForExistence(timeout: 10), "Tithes wasn't drawn")
    play.tap()
    let use = app.buttons.matching(NSPredicate(format: "label CONTAINS 'reorder your pile'")).firstMatch
    XCTAssertTrue(use.waitForExistence(timeout: 30), "Tithes' ability wasn't offered")
    use.tap()
    XCTAssertTrue(app.navigationBars["Tithes: your pile"].waitForExistence(timeout: 10), "no reorder")
    // (Its hint, or that it's thinking: a reorder is searched card by card, which takes a while.)
    let hint = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Midstrike would play: ' OR label BEGINSWITH 'Midstrike is thinking'")).firstMatch
    XCTAssertTrue(hint.waitForExistence(timeout: 10), "the reorder sheet shows no hint")
    // (Kept with the results, to look at.)
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "Tithes reorder with training mode"
    shot.lifetime = .keepAlways
    add(shot)
  }
}
