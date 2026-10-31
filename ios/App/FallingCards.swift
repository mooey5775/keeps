import SwiftUI

/// The game's cards drifting down behind the lobby, each turning slowly and swaying a little: nearer ones bigger,
/// faster and brighter, farther ones smaller, slower and dimmer. Still, scattered, with Reduce Motion.
struct FallingCards: View {
  let book: CardBook
  @Environment(\.accessibilityReduceMotion) private var still
  /// Dealt once, when the view is made.
  @State private var cards = Self.deal()

  /// One card's fall: where across, how near (0 far, 1 near), where it starts, how it turns and sways.
  private struct Falling {
    let id: CardId?
    let across: Double
    let near: Double
    let start: Double
    let tilt: Double
    let spin: Double
    let sway: Double
    let phase: Double
  }

  var body: some View {
    TimelineView(.animation(paused: still)) { timeline in
      Canvas { context, size in
        let time = still ? 0 : timeline.date.timeIntervalSinceReferenceDate
        // Farther cards first, so nearer ones pass in front.
        for card in cards.sorted(by: { $0.near < $1.near }) {
          guard let image = book.image(card.id) else { continue }
          let width = 42 + 60 * card.near
          let height = width * 1.4
          let speed = 14 + 38 * card.near  // points a second
          let span = size.height + 2 * height
          let y = (card.start * span + time * speed).truncatingRemainder(dividingBy: span) - height
          let x = card.across * size.width + sin(time * 0.35 + card.phase) * card.sway
          var layer = context
          layer.opacity = 0.18 + 0.4 * card.near
          layer.translateBy(x: x, y: y + height / 2)
          layer.rotate(by: .degrees(card.tilt + time * card.spin))
          let frame = CGRect(x: -width / 2, y: -height / 2, width: width, height: height)
          layer.clip(to: Path(roundedRect: frame, cornerRadius: width * 0.07))
          layer.draw(Image(uiImage: image), in: frame)
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// Fourteen cards, most face up, spread across the width and the fall.
  private static func deal() -> [Falling] {
    var random = SystemRandomNumberGenerator()
    let faces = CardId.allCases.shuffled(using: &random)
    return (0..<14).map { i in
      Falling(
        id: i % 5 == 4 ? nil : faces[i % faces.count],
        across: (Double(i) + Double.random(in: 0.1...0.9, using: &random)) / 14,
        near: Double.random(in: 0...1, using: &random),
        start: Double.random(in: 0...1, using: &random),
        tilt: Double.random(in: -25...25, using: &random),
        spin: Double.random(in: -9...9, using: &random),
        sway: Double.random(in: 4...18, using: &random),
        phase: Double.random(in: 0...(2 * .pi), using: &random))
    }
  }
}
