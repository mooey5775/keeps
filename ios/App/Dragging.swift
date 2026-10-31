import SwiftUI

/// Cards side by side, overlapping as much as they must to fit the width offered (your hand, a keep): every card
/// stays on the table, none scrolls out of reach, and a card can be picked up without the row scrolling instead.
struct Fan: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
    let natural = natural(sizes)
    return CGSize(width: min(natural, proposal.width ?? natural), height: sizes.map(\.height).max() ?? 0)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
    guard let last = sizes.last else { return }
    let squeezed = natural(sizes) > bounds.width && sizes.count > 1
    let step = squeezed ? (bounds.width - last.width) / CGFloat(sizes.count - 1) : 0
    var x = bounds.minX
    for (subview, size) in zip(subviews, sizes) {
      subview.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(size))
      x += squeezed ? step : size.width + spacing
    }
  }

  private func natural(_ sizes: [CGSize]) -> CGFloat {
    sizes.reduce(0) { $0 + $1.width } + spacing * CGFloat(max(0, sizes.count - 1))
  }
}

/// Where each table element is (in the table's coordinate space), for finding what a dragged card is let go over.
/// Not observed: the frames change as the table lays out, and nothing is drawn from them.
final class DropZones {
  static let space = "table-space"
  fileprivate var frames: [String: CGRect] = [:]

  /// Each card's place on the table (where it is now): where a card moving across the table sets off from and lands.
  fileprivate var cards: [CardId: CGRect] = [:]

  var cardFrames: [CardId: CGRect] { cards }

  /// Told each time a card's place is laid out (a card arriving there, or one already there moving): the table's
  /// flights land on it.
  var onPlace: (CardId, CGRect) -> Void = { _, _ in }

  /// The element under `point` among `refs` (the innermost, when one holds another: a card in a keep).
  func element(at point: CGPoint, among refs: Set<String>) -> String? {
    frames.filter { refs.contains($0.key) && $0.value.contains(point) }.min { $0.value.width * $0.value.height < $1.value.width * $1.value.height }?.key
  }
}

private struct DropZonesKey: EnvironmentKey {
  static let defaultValue = DropZones()
}

extension EnvironmentValues {
  var dropZones: DropZones {
    get { self[DropZonesKey.self] }
    set { self[DropZonesKey.self] = newValue }
  }
}

extension View {
  /// Registers this view as the table element `ref`, for drops.
  func dropZone(_ ref: String) -> some View { modifier(DropZoneModifier(ref: ref)) }

  /// Registers this view as `card`'s place on the table, for a card let go to move to.
  func cardPlace(_ card: CardId?) -> some View { modifier(CardPlaceModifier(card: card)) }
}

private struct Place: Equatable {
  let card: CardId
  let frame: CGRect
}

private struct CardPlaceModifier: ViewModifier {
  let card: CardId?
  @Environment(\.dropZones) private var zones

  func body(content: Content) -> some View {
    if let card {
      // (The card is part of what's watched: a place that shows a new card, the discard's top, is that card's place.)
      content.onGeometryChange(for: Place.self, of: { Place(card: card, frame: $0.frame(in: .named(DropZones.space))) }) {
        zones.cards[$0.card] = $0.frame
        zones.onPlace($0.card, $0.frame)
      }
    } else {
      content
    }
  }
}

private struct DropZoneModifier: ViewModifier {
  let ref: String
  @Environment(\.dropZones) private var zones

  func body(content: Content) -> some View {
    content.onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(DropZones.space)) }) { zones.frames[ref] = $0 }
  }
}
