import SwiftUI
import UIKit

/// The card being held (Game.preview), shown full screen over everything, sheets and alerts included: it's drawn in a
/// window of its own above the app's, which takes no touches (the finger holding the card keeps holding it below).
struct PreviewWindow: UIViewRepresentable {
  let game: Game

  func makeUIView(context: Context) -> Anchor { Anchor(game: game) }
  func updateUIView(_ view: Anchor, context: Context) {}

  /// Puts the preview's window up once it's in the app's window (its scene is then known), and keeps it.
  final class Anchor: UIView {
    let game: Game
    private var shown: UIWindow?

    init(game: Game) {
      self.game = game
      super.init(frame: .zero)
      isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func didMoveToWindow() {
      super.didMoveToWindow()
      guard shown == nil, let scene = window?.windowScene else { return }
      let over = PassingWindow(windowScene: scene)
      over.windowLevel = .alert + 1
      over.overrideUserInterfaceStyle = .dark
      let host = UIHostingController(rootView: Layer(game: game))
      host.view.backgroundColor = .clear
      over.rootViewController = host
      over.isHidden = false
      shown = over
    }
  }

  /// The preview, when there is one.
  private struct Layer: View {
    let game: Game

    var body: some View {
      ZStack {
        if let id = game.preview { CardPreview(book: game.book, id: id).transition(.opacity.combined(with: .scale(scale: 0.92))) }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .animation(.snappy(duration: 0.2), value: game.preview)
    }
  }

  /// A window that every touch passes through, to the app's below.
  private final class PassingWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
  }
}
