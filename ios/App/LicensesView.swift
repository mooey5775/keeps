import SwiftUI

/// What the app ships that isn't ours, each with its licence in full (the texts are ios/build/licenses, copied there by
/// ios/tools/build-core.sh from the repository's own licence files). The core's code is all ours: build-core.sh fails if
/// a package from elsewhere gets into it, so it can't ship without its licence here.
struct LicensesView: View {
  private struct Item: Identifiable {
    let name: String
    let what: String
    /// Its licence's file in the app's licenses folder; nil for what's credited, not licensed to us.
    let file: String?
    var id: String { name }
  }

  private let items = [
    Item(name: "Libre Baskerville", what: "The text font. SIL Open Font License 1.1", file: "LibreBaskerville-OFL.txt"),
    Item(name: "HamletOrNot", what: "The heading font, by Manfred Klein and Petra Heidorn. Free for commercial use", file: "HamletOrNot-LICENSE.txt"),
    // (As the website and Settings credit them.)
    Item(name: "Keeps", what: "The game is by David & Elaina Buffkin. Card art © their respective owners", file: nil),
  ]

  var body: some View {
    List(items) { item in
      if let file = item.file {
        NavigationLink {
          LicenseText(name: item.name, file: file)
        } label: {
          row(item)
        }
      } else {
        row(item)
      }
    }
    .navigationTitle("Licenses")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func row(_ item: Item) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(item.name)
      Text(item.what).font(.footnote).foregroundStyle(.secondary)
    }
    // (Named by its name alone, what it is read after; a row with a licence is its NavigationLink's button.)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(item.name)
    .accessibilityValue(item.what)
  }
}

/// One licence, in full.
private struct LicenseText: View {
  let name: String
  let file: String

  var body: some View {
    ScrollView {
      Text(Self.reflowed(text))
        .font(.footnote)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
    }
    .navigationTitle(name)
    .navigationBarTitleDisplayMode(.inline)
  }

  /// The text joined back into paragraphs: licence files are wrapped at about 80 columns, a phone's screen at about 40,
  /// so a line long enough to have been wrapped runs on into the next, and a short one (a heading, a paragraph's end)
  /// ends where it does. Lines of dashes, decoration, are left out.
  static func reflowed(_ text: String) -> String {
    // (Line ends as Windows writes them too: the Open Font License's file has them.)
    let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
      .filter { !($0.contains("-") && $0.allSatisfy { $0 == "-" || $0 == " " }) }
    // The wrapping width: most lines' length (a long first line, a copyright notice say, doesn't count).
    let lengths = lines.map(\.count).filter { $0 > 0 }.sorted()
    let width = lengths.isEmpty ? 0 : lengths[(lengths.count - 1) * 3 / 4]
    var out: [String] = []
    var previous = ""
    for line in lines {
      let wrapped = !previous.trimmingCharacters(in: .whitespaces).isEmpty && Double(previous.count) >= 0.6 * Double(width)
      if wrapped, !line.trimmingCharacters(in: .whitespaces).isEmpty, !out.isEmpty {
        out[out.count - 1] += " " + line.trimmingCharacters(in: .whitespaces)
      } else {
        out.append(line)
      }
      previous = line
    }
    return out.joined(separator: "\n")
  }

  private var text: String {
    guard let url = Bundle.main.url(forResource: file, withExtension: nil, subdirectory: "licenses"),
      let text = try? String(contentsOf: url, encoding: .utf8)
    else { return "(The licence's text is missing from this build.)" }
    return text
  }
}
