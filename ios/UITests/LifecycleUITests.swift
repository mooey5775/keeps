import XCTest

/// A game's life on the phone: kept through the app closing and the core's process ending, left, reviewed, reported; and the settings.
final class LifecycleUITests: KeepsUITestCase {
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
    app = newApp()
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

  func testLeavingAGameAgainstMidstrikeGivesItUp() throws {
    launch()
    XCTAssertTrue(yourTurn())
    app.buttons["Game menu"].tap()
    app.buttons["Leave game"].tap()
    // Said first: leaving gives the game up.
    XCTAssertTrue(app.staticTexts["Midstrike wins the game."].waitForExistence(timeout: 5), "leaving didn't say what it gives up")
    app.buttons["Leave"].tap()
    // Gone for good: nothing to continue.
    XCTAssertTrue(app.buttons["Play"].waitForExistence(timeout: 10), "leaving didn't go back to the lobby")
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Continue'")).firstMatch.exists, "the game left is still offered")
    XCTAssertFalse(app.alerts["Something went wrong"].exists)
  }

  func testAGameKeptWhenTheAppClosedIsLeftBeforeAnotherStarts() throws {
    launch()
    XCTAssertTrue(yourTurn())
    yourPile.tap()
    placeHot()
    // Closed (as a dead battery would): the game is kept.
    app.terminate()
    app.launchEnvironment["KEEPS_PLAY"] = nil
    app.launch()
    let here = app.buttons["On this phone"]
    XCTAssertTrue(here.waitForExistence(timeout: 30))
    here.tap()
    let resume = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Continue'")).firstMatch
    XCTAssertTrue(resume.waitForExistence(timeout: 30), "the lobby doesn't offer the kept game")
    // Another game: the phone holds one at a time, so the kept one is left first (asked).
    app.buttons["New game"].tap()
    app.buttons["Leave it and go on"].tap()
    XCTAssertTrue(eventually(30) { self.yourPile.exists }, "the new game didn't start")
    app.buttons["Game menu"].tap()
    app.buttons["Leave game"].tap()
    app.buttons["Leave"].tap()
    XCTAssertTrue(app.buttons["Play"].waitForExistence(timeout: 10))
    XCTAssertFalse(resume.exists, "a game left is still offered")
  }

  func testAProblemIsReportedFromTheMenu() throws {
    launch()
    XCTAssertTrue(yourTurn())
    app.buttons["Game menu"].tap()
    app.buttons["Report a problem"].tap()
    let text = app.textFields["report text"]
    XCTAssertTrue(text.waitForExistence(timeout: 5), "no report to write")
    // With the screen as it was, to send or not.
    XCTAssertTrue(app.switches["Include a screenshot"].exists, "no screenshot offered")
    XCTAssertFalse(app.buttons["Send"].isEnabled, "an empty report can be sent")
    text.tap()
    text.typeText("The card flew to the wrong keep.")
    XCTAssertTrue(app.buttons["Send"].isEnabled)
    // (Not sent: the tests have no server for it.)
    app.buttons["Cancel"].tap()
    XCTAssertTrue(eventually(5) { !text.exists }, "the report didn't close")
    XCTAssertTrue(yourPile.exists, "the table isn't back")
  }

  func testShakingReportsAProblemOverASheet() throws {
    app = newApp()
    app.launchEnvironment["KEEPS_PLAY"] = "easy:5"
    app.launchEnvironment["KEEPS_SEED"] = Deal.alone.rawValue
    app.launchEnvironment["KEEPS_TEST_HOOKS"] = "1"
    app.launch()
    XCTAssertTrue(yourTurn())
    // The log open over the table (a sheet), then a shake: the report comes over the log.
    app.buttons["Game log"].tap()
    XCTAssertTrue(app.navigationBars["Game log"].waitForExistence(timeout: 5), "no log")
    shake()
    let text = app.textFields["report text"]
    XCTAssertTrue(text.waitForExistence(timeout: 5), "shaking over the log started no report")
    app.buttons["Cancel"].tap()
    XCTAssertTrue(eventually(5) { !text.exists }, "the report didn't close")
    XCTAssertTrue(app.navigationBars["Game log"].exists, "the log went with the report")
    // And again: one report closed, another can begin.
    shake()
    XCTAssertTrue(text.waitForExistence(timeout: 5), "a second shake started no report")
  }

  /// A shake, as the app's test hook takes it (KEEPS_TEST_HOOKS; the tests can't shake the phone).
  private func shake() {
    CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName("online.playkeeps.test.shake" as CFString), nil, nil, true)
  }

  func testARoundIsReviewedOnThePhone() throws {
    // A game to one mark, your moves made at random until it's over.
    app = newApp()
    app.launchEnvironment["KEEPS_PLAY"] = "easy:1:400"
    app.launchEnvironment["KEEPS_SEED"] = Deal.alone.rawValue
    app.launch()
    let review = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Round 1 review'")).firstMatch
    XCTAssertTrue(review.waitForExistence(timeout: 240), "the round wasn't reviewed")
    review.tap()
    XCTAssertTrue(app.descendants(matching: .any)["round review"].waitForExistence(timeout: 10), "the review didn't open")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Turn 1'")).firstMatch.waitForExistence(timeout: 10), "the review shows no turns")
    // (Kept with the results, to look at: the review as it opened.)
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "round review"
    shot.lifetime = .keepAlways
    add(shot)
    app.swipeUp()
    let later = XCTAttachment(screenshot: app.screenshot())
    later.name = "round review, further down"
    later.lifetime = .keepAlways
    add(later)
    app.buttons["Done"].tap()
    XCTAssertFalse(app.alerts["Something went wrong"].exists)
  }

  func testSettingsCreditTheGameOfferToBuyItAndSwitchReviews() throws {
    app = newApp()
    app.launch()
    let settings = app.buttons["Settings"]
    XCTAssertTrue(settings.waitForExistence(timeout: 30), "no lobby")
    XCTAssertTrue(app.descendants(matching: .any)["Keeps is by David & Elaina Buffkin"].exists, "the lobby doesn't credit the game's makers")
    settings.tap()
    XCTAssertTrue(app.descendants(matching: .any)["Buy Keeps on Amazon"].waitForExistence(timeout: 5), "no link to buy the game")
    XCTAssertTrue(app.switches["Share statistics about my games on this phone"].exists, "no sharing setting")
    // Off until turned on.
    XCTAssertEqual(app.switches["Share statistics about my games on this phone"].value as? String, "0")
    // Round reviews: on until turned off.
    XCTAssertEqual(app.switches["Round reviews"].value as? String, "1")
    app.buttons["Done"].tap()
  }
}
