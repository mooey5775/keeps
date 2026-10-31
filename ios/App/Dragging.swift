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
  static let space = "table"
  fileprivate var frames: [String: CGRect] = [:]

  /// The element under `point` among `refs` (the innermost, when one holds another: a card in a keep).
  func element(at point: CGPoint, among refs: Set<String>) -> String? {
    frames.filter { refs.contains($0.key) && $0.value.contains(point) }.min { $0.value.width * $0.value.height < $1.value.width * $1.value.height }?.key
  }
}

private struct DropZonesKey: EnvironmentKey {
  static let defaultValue = DropZones()
}

/// The table's namespace for cards gliding from one place to another (a card is the same view wherever it goes).
private struct CardSpaceKey: EnvironmentKey {
  static let defaultValue: Namespace.ID? = nil
}

extension EnvironmentValues {
  var dropZones: DropZones {
    get { self[DropZonesKey.self] }
    set { self[DropZonesKey.self] = newValue }
  }
  var cardSpace: Namespace.ID? {
    get { self[CardSpaceKey.self] }
    set { self[CardSpaceKey.self] = newValue }
  }
}

extension View {
  /// Registers this view as the table element `ref`, for drops.
  func dropZone(_ ref: String) -> some View { modifier(DropZoneModifier(ref: ref)) }
}

private struct DropZoneModifier: ViewModifier {
  let ref: String
  @Environment(\.dropZones) private var zones

  func body(content: Content) -> some View {
    content.onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(DropZones.space)) }) { zones.frames[ref] = $0 }
  }
}
