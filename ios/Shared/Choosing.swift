import Foundation

/// Choosing a move by touching the table: web/src/game/options.ts's narrow, click, clickable and panelItems, in Swift
/// (ChoosingTests holds them to the TypeScript's own answers, recorded by ios/tools/swift-types/goldens.ts).
///
/// Every option lists the table elements it involves (its refs: "hand:dagger", "pile:2", "keep:0", "keepcard:0:1",
/// "discard:fiat", "player:2", "shown:0"). Touching elements narrows the options to those involving all of them; once
/// one remains and every element it needs has been touched, it is the move. The panel lists the options left as
/// buttons, folding many that start with the same element into one ("Play Dagger…") that touches it.
enum Choosing {
  /// Fold options into groups once there are more than this many.
  static let groupAbove = 6

  /// Options still possible after touching `picked` (each must be involved).
  static func narrow(_ options: [Option], _ picked: [String]) -> [Option] {
    options.filter { option in picked.allSatisfy(option.refs.contains) }
  }

  enum Touch: Equatable {
    /// The move.
    case send(Command)
    /// The elements touched so far (touching one again lets it go).
    case pick([String])
    /// Nothing to do with that element.
    case ignore
  }

  /// A touch on a table element. A move once exactly one option remains and all its elements have been touched;
  /// otherwise the touched elements, this one added (or, if nothing involves them all, this one alone). A first touch
  /// also makes the one move it completes when that move starts at the touched element and every other move involving
  /// it starts elsewhere (your pile draws, though Sanction could draw from it: Sanction's moves start at Sanction).
  static func touch(_ options: [Option], _ picked: [String], _ ref: String) -> Touch {
    if picked.contains(ref) { return .pick(picked.filter { $0 != ref }) }
    var next = picked + [ref]
    var remaining = narrow(options, next)
    if remaining.isEmpty {
      next = [ref]
      remaining = narrow(options, next)
      if remaining.isEmpty { return .ignore }
    }
    if remaining.count == 1, remaining[0].refs.allSatisfy(next.contains) { return .send(remaining[0].command) }
    if next.count == 1 {
      let startingHere = remaining.filter { ($0.starts ?? Array($0.refs.prefix(1))).contains(ref) }
      if startingHere.count == 1, startingHere[0].refs.allSatisfy(next.contains) { return .send(startingHere[0].command) }
    }
    return .pick(next)
  }

  /// The decision a command answers: its prompt, or the command itself (next round, Duplicity's reveal).
  static func decision(_ command: Command) -> String {
    switch command {
    case .answer(let answer): "prompt:\(answer.promptId)"
    case .nextRound: "next-round"
    case .revealDuplicity: "reveal-duplicity"
    }
  }

  /// Whether `command` answers a decision open in the position whose legal moves are `legal`: a move made from a button
  /// not yet redrawn for the next position answers one already answered. Not whether it's a legal answer (that's the
  /// engine's to say, and it says so loudly): a pile's order is any order of its cards, though its legal moves list
  /// only two.
  static func answersOpen(_ command: Command, _ legal: [Command]) -> Bool {
    let wanted = decision(command)
    return legal.contains { decision($0) == wanted }
  }

  /// Elements worth touching next. Before anything is touched, only those an option can start from (the card to play,
  /// the pile to draw from, the ability card; either card of a Providence swap), so targets light up once you've
  /// chosen what to do.
  static func touchable(_ options: [Option], _ picked: [String]) -> Set<String> {
    var set = Set<String>()
    for option in narrow(options, picked) {
      if picked.isEmpty {
        set.formUnion(option.starts ?? Array(option.refs.prefix(1)))
      } else {
        set.formUnion(option.refs.filter { !picked.contains($0) })
      }
    }
    return set
  }

  enum PanelItem: Equatable {
    case option(Option)
    /// Options that share their next element: choosing it touches that element.
    case group(ref: String, label: String, count: Int)
  }

  /// The panel's buttons for the options still possible (see the type's comment).
  static func panelItems(_ options: [Option], _ picked: [String]) -> [PanelItem] {
    if options.count <= groupAbove { return options.map { .option($0) } }
    func next(_ option: Option) -> (ref: String, label: String)? {
      guard let ref = option.refs.first(where: { !picked.contains($0) }), let index = option.refs.firstIndex(of: ref),
        let groups = option.groups, index < groups.count
      else { return nil }
      return (ref, groups[index])
    }
    var sizes: [String: Int] = [:]
    for option in options {
      if let n = next(option) { sizes[n.ref, default: 0] += 1 }
    }
    var items: [PanelItem] = []
    var seen = Set<String>()
    for option in options {
      guard let n = next(option), sizes[n.ref, default: 0] >= 2 else {
        items.append(.option(option))
        continue
      }
      if seen.insert(n.ref).inserted { items.append(.group(ref: n.ref, label: n.label, count: sizes[n.ref]!)) }
    }
    return items
  }

  /// The cards a group is about, pictured on its button (those every option in it shares).
  static func groupCards(_ options: [Option], _ ref: String) -> [CardId] {
    let members = options.filter { $0.refs.contains(ref) }
    let first = members.first?.cards ?? []
    return first.filter { card in members.allSatisfy { $0.cards.contains(card) } }
  }
}
