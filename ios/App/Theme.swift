import CoreText
import SwiftUI

/// The game's look, as the website has it (web/src/styles.css): dark wood and parchment, gold for what you can do,
/// HamletOrNot for headings and Libre Baskerville for text. Panels over the table use the system's materials.
enum Theme {
  static let background = Color(hex: 0x16120d)
  static let raised = Color(hex: 0x221b14)
  static let panel = Color(hex: 0x2b2219)
  static let line = Color(hex: 0x4a3b2a)
  static let text = Color(hex: 0xecdfc4)
  static let muted = Color(hex: 0xb3a283)
  static let gold = Color(hex: 0xd2a94d)
  static let goldBright = Color(hex: 0xf3cf74)
  static let blue = Color(hex: 0x7d8fb0)
  static let danger = Color(hex: 0xe07a62)
  static let ok = Color(hex: 0x8fc27a)

  /// Headings: HamletOrNot, scaled with Dynamic Type like `style`.
  static func heading(_ size: CGFloat, relativeTo style: Font.TextStyle = .title) -> Font {
    .custom("HamletOrNot", size: size, relativeTo: style)
  }

  /// Text: Libre Baskerville, at the size of `style` (it runs wide, so a little under the system's), scaled with it.
  static func text(_ style: Font.TextStyle = .body) -> Font {
    let size: CGFloat =
      switch style {
      case .largeTitle: 30
      case .title: 24
      case .title2: 20
      case .title3: 18
      case .headline, .body: 15
      case .callout: 14
      case .subheadline: 13
      case .footnote: 12
      case .caption: 11
      default: 10
      }
    return .custom("Libre Baskerville", size: size, relativeTo: style)
  }

  /// Registers the fonts in the app's fonts folder (sync.sh puts them there), so the names above find them.
  static func registerFonts() {
    let urls = Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: "fonts") ?? []
    CTFontManagerRegisterFontURLs(urls as CFArray, .process, true, nil)
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255)
  }
}
