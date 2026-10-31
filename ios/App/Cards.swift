import SwiftUI
import UIKit

/// The cards' names, texts and pictures: the core sends them when it starts (ToAppReady.cards); the pictures are the
/// website's, in the app's cards folder (sync.sh copies them).
@MainActor
final class CardBook {
  private let info: [CardId: CardInfo]
  private var images: [String: UIImage] = [:]

  init(_ cards: [CardInfo]) {
    info = Dictionary(uniqueKeysWithValues: cards.map { ($0.id, $0) })
  }

  func name(_ id: CardId) -> String { info[id]?.name ?? id.rawValue }
  func text(_ id: CardId) -> String { info[id]?.text ?? "" }

  /// The card's picture; nil for the back.
  func image(_ id: CardId?) -> UIImage? {
    let file = id.flatMap { info[$0]?.image } ?? "Card_Back.webp"
    if let image = images[file] { return image }
    guard let url = Bundle.main.url(forResource: file, withExtension: nil, subdirectory: "cards"), let image = UIImage(contentsOfFile: url.path) else {
      return nil
    }
    images[file] = image
    return image
  }
}

/// How a card on the table answers a touch: not at all, worth touching (gold), or touched (lifted, bright gold).
enum Touchability {
  case none, touchable, picked
}

/// A card: its picture (or the back), `width` wide, framed by whether it can be touched. A face-down card you know
/// (one you hid with Duplicity) shows its face, darkened and marked hidden; one you don't know, the back.
struct CardView: View {
  let book: CardBook
  let id: CardId?
  var faceDown = false
  let width: CGFloat
  var touch: Touchability = .none

  var body: some View {
    let radius = width * 0.07
    let hiddenFromOthers = faceDown && id != nil
    Group {
      if let image = book.image(id) {
        Image(uiImage: image).resizable().interpolation(.high)
      } else {
        Theme.raised
      }
    }
    .frame(width: width, height: width * 1.4)
    .overlay {
      if hiddenFromOthers {
        ZStack(alignment: .topTrailing) {
          Color.black.opacity(0.45)
          Image(systemName: "eye.slash.fill")
            .font(.system(size: max(9, width * 0.2), weight: .semibold))
            .foregroundStyle(Theme.goldBright)
            .padding(width * 0.06)
            .background(Color.black.opacity(0.6), in: Circle())
            .padding(width * 0.05)
        }
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: radius))
    .overlay {
      RoundedRectangle(cornerRadius: radius)
        .strokeBorder(touch == .picked ? Theme.goldBright : touch == .touchable ? Theme.gold : Theme.line, lineWidth: touch == .none ? 0.5 : 2)
    }
    .shadow(color: touch == .none ? .black.opacity(0.4) : Theme.gold.opacity(touch == .picked ? 0.9 : 0.6), radius: touch == .none ? 2 : 6)
    .offset(y: touch == .picked ? -width * 0.12 : 0)
    .animation(.snappy(duration: 0.18), value: touch)
    .accessibilityLabel(id.map { "\(book.name($0))\(faceDown ? ", face down (hidden from the others)" : "")" } ?? "Face-down card")
  }
}
