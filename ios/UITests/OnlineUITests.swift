import XCTest

/// Online, on the website's server (ios/tools/test-server.ts, which ios/test.sh runs and forwards to the Mac): rooms made, joined and played, seats taken back, games of three and four.
final class OnlineUITests: KeepsUITestCase {
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
    // Drawing until a card stays in your hand (a HOT one goes into your keep, and may ask more of you: the deal online
    // is the server's, so any other decision is answered with its first move).
    let move = app.buttons.matching(identifier: "move").firstMatch
    for _ in 0..<12 where handCards.isEmpty {
      XCTAssertTrue(eventually(60) { self.app.buttons["Draw from your pile"].exists || move.exists }, "no decision came")
      if app.buttons["Draw from your pile"].exists {
        yourPile.tap()
        placeHot()
        _ = eventually(3) { !self.handCards.isEmpty }
      } else if putIntoYourKeep.exists {
        putIntoYourKeep.tap()
      } else {
        move.tap()
      }
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
    leaveWhatsHeld()
    let alert = app.alerts["Something went wrong"]
    XCTAssertTrue(alert.waitForExistence(timeout: 10), "joining a room that isn't there said nothing")
    XCTAssertTrue(alert.staticTexts.matching(NSPredicate(format: "label CONTAINS 'ZZZZ'")).firstMatch.exists)
  }

  func testAGameOfThreeShowsEveryPlayer() throws { playOnlineWith(others: 2) }

  func testAPlayerWhoIsAwayIsMarkedSo() throws {
    let code = playOnlineWith(others: 2)
    XCTAssertFalse(element("Robot 1 away").exists)
    testServer("away?code=\(code)&name=Robot%201")
    XCTAssertTrue(element("Robot 1 away").waitForExistence(timeout: 10), "Robot 1 isn't marked away")
  }

  func testAGameOfFourShowsEveryPlayer() throws { playOnlineWith(others: 3) }
}
