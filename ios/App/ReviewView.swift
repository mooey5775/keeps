import Charts
import SwiftUI

/// After a round against Midstrike: your chance of winning it after every move (as it really was, every card known; as
/// you could tell; as Midstrike could tell), then every turn with its log, and at each decision the options as
/// Midstrike ranked them from what the decider knew, as training mode would have shown them. The website's review
/// (packages/web/src/game/RoundReview.tsx), the same review: the core works it out (packages/bot/src/review), on the
/// phone or on the website's server, and it fills in as it goes.
struct ReviewView: View {
  let game: Game
  let round: Int
  @Environment(\.dismiss) private var dismiss

  private var entry: Game.Review? { game.reviews.first { $0.id == round } }
  private let bot = "Midstrike"

  var body: some View {
    NavigationStack {
      Group {
        if let entry {
          content(entry)
        } else {
          ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .background(Theme.background)
      .navigationTitle("Round \(round) review")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .environment(\.colorScheme, .dark)
  }

  private func content(_ entry: Game.Review) -> some View {
    let review = entry.review
    let me = review.seat
    let mine = review.decisions.filter { $0.seat == me }
    return ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Text(result(review)).font(Theme.heading(22, relativeTo: .title3)).foregroundStyle(review.winner == me ? Theme.goldBright : Theme.text)
        if review.pending > 0 {
          Label("\(bot) is still working through the round. This fills in as it goes.", systemImage: "hourglass")
            .font(Theme.text(.footnote)).foregroundStyle(Theme.muted)
        }
        if !mine.isEmpty { Text(summary(mine)).font(Theme.text(.subheadline)).foregroundStyle(Theme.text) }
        chart(review)
        Text("At each decision, the options as \(bot) ranked them from what the deciding player knew, with each one's chance of winning the round: as they could tell, and with every card known.")
          .font(Theme.text(.caption)).foregroundStyle(Theme.muted)
        ForEach(turns(review), id: \.first) { moves in turn(entry, moves) }
      }
      .padding(16)
    }
    .accessibilityIdentifier("round review")
  }

  // MARK: The words

  private func result(_ review: RoundReview) -> String {
    let me = review.seat
    let them = review.scores.indices.first { $0 != me && review.scores[$0] != nil }
    let who = review.winner == me ? "You won" : review.winner == nil ? "Nobody won" : "\(bot) won"
    guard let them, let mine = review.scores[me] ?? nil, let theirs = review.scores[them] ?? nil else { return who }
    return "\(who), \(coins(mine)) coins to \(coins(theirs))"
  }

  /// "You played Midstrike's first choice at 7 of your 9 decisions (1 mistake)."
  private func summary(_ mine: [RoundReviewDecisionsElement]) -> String {
    let top = mine.filter { $0.options.first?.played == true }.count
    let flags: [(RoundReviewDecisionsElementVerdict, String, String)] = [
      (.blunder, "blunder", "blunders"), (.mistake, "mistake", "mistakes"),
      (.mistakeWorkedOut, "mistake that worked out", "mistakes that worked out"), (.unlucky, "unlucky move", "unlucky moves"),
    ]
    let counted = flags.compactMap { verdict, one, many -> String? in
      let n = mine.filter { $0.verdict == verdict }.count
      return n == 0 ? nil : "\(n) \(n == 1 ? one : many)"
    }
    return "You played \(bot)'s first choice at \(top) of your \(mine.count) decisions" + (counted.isEmpty ? "." : " (\(counted.joined(separator: ", "))).")
  }

  /// Half-coins, as the table shows them ("3½").
  private func coins(_ halves: Double) -> String {
    let n = Int(halves.rounded())
    let whole = abs(n) / 2
    let half = abs(n) % 2 == 1 ? "½" : ""
    return (n < 0 ? "−" : "") + (whole == 0 && !half.isEmpty ? half : "\(whole)\(half)")
  }

  private func pct(_ v: Double?) -> String { v.map { "\(Int(($0 * 100).rounded()))%" } ?? "…" }

  // MARK: The chart

  private struct Point: Identifiable {
    let move: Int
    let value: Double
    let series: Int
    /// Which unbroken stretch of its series it's in (a value not worked out yet breaks the line, as the website's does).
    let run: String
    var id: String { "\(series)-\(move)" }
  }

  private func chart(_ review: RoundReview) -> some View {
    let series: [(String, KeyPath<RoundReviewMovesElement, Double?>, Color)] = [
      ("Real (every card known)", \.truth, Theme.goldBright), ("As you could tell", \.mine, Theme.ok), ("As \(bot) could tell", \.theirs, Theme.blue),
    ]
    var points: [Point] = []
    for (k, (_, key, _)) in series.enumerated() {
      var run = 0
      for (i, m) in review.moves.enumerated() {
        guard let v = m[keyPath: key] else {
          run += 1
          continue
        }
        points.append(Point(move: i, value: v, series: k, run: "\(k)-\(run)"))
      }
    }
    return VStack(alignment: .leading, spacing: 6) {
      Text("Your chance of winning the round, after each move").font(Theme.text(.caption)).foregroundStyle(Theme.muted)
      Chart(points) { p in
        LineMark(x: .value("Move", p.move), y: .value("Chance", p.value), series: .value("Run", p.run))
          .foregroundStyle(series[p.series].2)
          .interpolationMethod(.linear)
      }
      .chartYScale(domain: 0...1)
      .chartXScale(domain: 0...max(1, review.moves.count - 1))
      .chartYAxis { AxisMarks(values: [0, 0.5, 1]) { AxisGridLine(); AxisValueLabel(format: FloatingPointFormatStyle<Double>.Percent()) } }
      .chartXAxis(.hidden)
      .frame(height: 180)
      // (Its own legend: the lines are drawn by stretch, which the chart's legend would list.)
      HStack(spacing: 12) {
        ForEach(series.indices, id: \.self) { k in
          HStack(spacing: 4) {
            Circle().fill(series[k].2).frame(width: 7, height: 7)
            Text(series[k].0).font(Theme.text(.caption2)).foregroundStyle(Theme.muted)
          }
        }
      }
    }
    .padding(12)
    .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12))
  }

  // MARK: The turns

  /// The moves' indices, by turn (in order).
  private func turns(_ review: RoundReview) -> [[Int]] {
    var out: [[Int]] = []
    for (i, m) in review.moves.enumerated() {
      if let last = out.last?.last, review.moves[last].turn == m.turn { out[out.count - 1].append(i) } else { out.append([i]) }
    }
    return out
  }

  private func turn(_ entry: Game.Review, _ moves: [Int]) -> some View {
    let review = entry.review
    let first = review.moves[moves[0]]
    let end = review.moves[moves.last!]
    let mine = first.seat == review.seat
    return VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Turn \(Int(first.turn)) · \(mine ? "You" : bot)").font(Theme.text(.headline)).foregroundStyle(Theme.text)
        Spacer()
        Text("\(pct(end.truth)) · \(pct(end.mine)) · \(pct(end.theirs))").font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
          .accessibilityLabel("Your chance: really \(pct(end.truth)), as you could tell \(pct(end.mine)), as \(bot) could tell \(pct(end.theirs))")
      }
      ForEach(moves, id: \.self) { i in
        if let decision = review.decisions.first(where: { Int($0.move) == i }) {
          Ranking(decision: decision, mine: decision.seat == review.seat, bot: bot)
        }
        if i < entry.lines.count {
          ForEach(Array(entry.lines[i].enumerated()), id: \.offset) { _, line in
            Text(line.text).font(Theme.text(.footnote)).foregroundStyle(Theme.text)
              .padding(.leading, CGFloat(max(0, Int(line.depth) - 1)) * 12)
          }
        }
      }
    }
    .padding(12)
    .background(mine ? Theme.panel : Theme.raised, in: RoundedRectangle(cornerRadius: 12))
  }
}

/// One decision: its options as Midstrike ranked them (the top three, and the one played if it isn't among them), each
/// with its chance as the decider could tell and with every card known; on your decisions, how your move compares.
private struct Ranking: View {
  let decision: RoundReviewDecisionsElement
  let mine: Bool
  let bot: String
  @State private var all = false

  var body: some View {
    let options = decision.options
    let played = options.first { $0.played }
    let top = Array(options.prefix(3))
    let shown = all ? options : top + (played.map { p in top.contains(p) ? [] : [p] } ?? [])
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(mine ? "\(bot) would play" : "\(bot) ranked its options").font(Theme.text(.caption)).foregroundStyle(Theme.muted)
        Spacer()
        if mine, let verdict = decision.verdict { chip(verdict) }
      }
      ForEach(Array(shown.enumerated()), id: \.offset) { _, option in
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text("\((options.firstIndex(of: option) ?? 0) + 1)").font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
          VStack(alignment: .leading, spacing: 2) {
            Text(option.label).font(Theme.text(.footnote)).foregroundStyle(Theme.text)
            if option.played { Text(mine ? "you played" : "played").font(Theme.text(.caption2)).foregroundStyle(Theme.gold) }
          }
          Spacer()
          Text(pct(option.known)).font(.footnote.monospacedDigit()).foregroundStyle(Theme.text)
          Text(pct(option.truth)).font(.footnote.monospacedDigit()).foregroundStyle(Theme.muted)
        }
        .padding(.vertical, 2)
        .background(option.played ? Theme.gold.opacity(0.12) : .clear)
      }
      HStack {
        if options.count > shown.count { Button("\(options.count - shown.count) more") { all = true }.font(Theme.text(.caption)) }
        Spacer()
        Text("\(mine ? "you knew" : "it knew") · all cards").font(Theme.text(.caption2)).foregroundStyle(Theme.muted)
      }
    }
    .padding(10)
    .background(Theme.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
  }

  private func pct(_ v: Double?) -> String { v.map { "\(Int(($0 * 100).rounded()))%" } ?? "…" }

  private func chip(_ verdict: RoundReviewDecisionsElementVerdict) -> some View {
    let (label, color): (String, Color) = switch verdict {
    case .best: ("Best", Theme.ok)
    case .mistake: ("Mistake", Theme.gold)
    case .mistakeWorkedOut: ("Mistake, worked out", Theme.gold)
    case .blunder: ("Blunder", Theme.danger)
    case .unlucky: ("Unlucky", Theme.blue)
    }
    return Text(label).font(Theme.text(.caption)).foregroundStyle(color)
      .padding(.horizontal, 8).padding(.vertical, 2)
      .overlay { Capsule().strokeBorder(color.opacity(0.7)) }
  }
}
