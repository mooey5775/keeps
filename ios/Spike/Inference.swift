import CoreML
import Foundation

/// The policy network in Core ML (KeepsPolicy, made by bot/keeps_bot/coreml.py): float16 observations [B, O] to
/// logits [B, 48], B one of the model's fixed batch sizes (the Neural Engine runs only fixed shapes), so each
/// request's rows are padded up to the next size, or cut into the largest.
///
/// Requests run in LANES at once, each with its own input buffers: while one is on the Neural Engine, another's
/// observations are being unpacked (MLModel's predictions are thread-safe). Two is enough for that overlap on any
/// device; more would only queue at the Neural Engine.
final class Inference {
  static let lanes = 2
  let metadata: [String: String]
  private let url: URL
  private let size: Int
  private let actions: Int
  private let batches: [Int]
  private var model: MLModel
  private var units = "ane"
  private let lock = NSLock()
  private let laneSlots = DispatchSemaphore(value: Inference.lanes)
  /// Each free lane's input arrays, by batch size (reused, zeroed before each use).
  private var freeLanes: [[Int: MLMultiArray]] = Array(repeating: [:], count: Inference.lanes)
  private var times = Times()

  /// Where a request's time goes, summed over requests (seconds).
  struct Times: Codable {
    var requests = 0, rows = 0
    var parse = 0.0, fill = 0.0, predict = 0.0, read = 0.0
  }

  init() throws {
    guard let url = Bundle.main.url(forResource: "KeepsPolicy", withExtension: "mlmodelc") else { throw SpikeError("KeepsPolicy.mlmodelc isn't in the app") }
    self.url = url
    model = try Self.load(url, units: "ane")
    metadata = model.modelDescription.metadata[.creatorDefinedKey] as? [String: String] ?? [:]
    guard let size = Int(metadata["observationSize"] ?? ""), let actions = Int(metadata["numActions"] ?? ""),
          case let batches = (metadata["batches"] ?? "").split(separator: ",").compactMap({ Int($0) }), !batches.isEmpty
    else { throw SpikeError("the model's metadata lacks its sizes: \(metadata)") }
    (self.size, self.actions, self.batches) = (size, actions, batches.sorted())
  }

  private static func load(_ url: URL, units: String) throws -> MLModel {
    let config = MLModelConfiguration()
    config.computeUnits = try computeUnits(units)
    return try MLModel(contentsOf: url, configuration: config)
  }

  private static func computeUnits(_ name: String) throws -> MLComputeUnits {
    switch name {
    case "ane": return .cpuAndNeuralEngine
    case "gpu": return .cpuAndGPU
    case "cpu": return .cpuOnly
    case "all": return .all
    default: throw SpikeError("unknown compute units \(name)")
    }
  }

  func setUnits(_ name: String) throws {
    try exclusive {
      guard name != units else { return }
      model = try Self.load(url, units: name)
      units = name
      freeLanes = Array(repeating: [:], count: Self.lanes)
    }
  }

  /// The time summed since the last call, as JSON.
  func takeTimes() throws -> Data {
    lock.lock()
    let t = times
    times = Times()
    lock.unlock()
    return try JSONEncoder().encode(t)
  }

  /// Runs `body` with every lane held: nothing else uses the model meanwhile.
  private func exclusive<T>(_ body: () throws -> T) rethrows -> T {
    for _ in 0..<Self.lanes { laneSlots.wait() }
    defer { for _ in 0..<Self.lanes { laneSlots.signal() } }
    return try body()
  }

  private func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }

  /// A request's logits (the inference protocol: rows, nonzeros, rowEnds, values, indices → float32 logits).
  func forward(_ body: Data) throws -> Data {
    laneSlots.wait()
    lock.lock()
    var inputs = freeLanes.removeLast()
    let model = self.model
    lock.unlock()
    defer {
      lock.lock()
      freeLanes.append(inputs)
      lock.unlock()
      laneSlots.signal()
    }
    var t = Times()
    var clock = now()
    func lap(_ part: WritableKeyPath<Times, Double>) {
      let at = now()
      t[keyPath: part] += at - clock
      clock = at
    }
    let request = try Request(body)
    lap(\.parse)
    var out = Data(count: request.rows * actions * 4)
    var start = 0
    while start < request.rows {
      let n = min(request.rows - start, batches.last!)
      let batch = batches.first { $0 >= n }!
      let input = try inputs[batch] ?? MLMultiArray(shape: [NSNumber(value: batch), NSNumber(value: size)], dataType: .float16)
      inputs[batch] = input
      input.withUnsafeMutableBufferPointer(ofType: Float16.self) { x, strides in
        x.update(repeating: 0)
        for r in 0..<n {
          let row = start + r
          for k in (row == 0 ? 0 : request.ends[row - 1])..<request.ends[row] {
            x[r * strides[0] + Int(request.indices[k]) * strides[1]] = Float16(request.values[k])
          }
        }
      }
      lap(\.fill)
      let result = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["obs": MLFeatureValue(multiArray: input)]))
      lap(\.predict)
      guard let logits = result.featureValue(for: "logits")?.multiArrayValue else { throw SpikeError("no logits") }
      let strides = logits.strides.map(\.intValue)
      out.withUnsafeMutableBytes { raw in
        let y = raw.bindMemory(to: Float32.self)
        switch logits.dataType {
        case .float16:
          logits.withUnsafeBufferPointer(ofType: Float16.self) { p in
            for r in 0..<n { for a in 0..<actions { y[(start + r) * actions + a] = Float32(p[r * strides[0] + a * strides[1]]) } }
          }
        default:
          logits.withUnsafeBufferPointer(ofType: Float32.self) { p in
            for r in 0..<n { for a in 0..<actions { y[(start + r) * actions + a] = p[r * strides[0] + a * strides[1]] } }
          }
        }
      }
      lap(\.read)
      start += n
    }
    lock.lock()
    times.requests += 1
    times.rows += request.rows
    times.parse += t.parse
    times.fill += t.fill
    times.predict += t.predict
    times.read += t.read
    lock.unlock()
    return out
  }

  /// The answer's size for the request, all zeros: the bridge's cost without the network.
  func echo(_ body: Data) throws -> Data {
    Data(count: try Request(body).rows * actions * 4)
  }

  /// Core ML's own speed, natively timed: for each compute units choice, where the model's operations run and how
  /// long a call takes at each batch size (all-zero input: the time doesn't depend on the values).
  func bench() throws -> String {
    var lines: [String] = []
    let previous = units
    defer { try? setUnits(previous) }
    for name in ["ane", "gpu", "cpu", "all"] {
      let started = Date()
      try setUnits(name)
      let loaded = Date().timeIntervalSince(started)
      var cells: [String] = []
      for batch in batches {
        let input = try MLMultiArray(shape: [NSNumber(value: batch), NSNumber(value: size)], dataType: .float16)
        input.withUnsafeMutableBufferPointer(ofType: Float16.self) { x, _ in x.update(repeating: 0) }
        let features = try MLDictionaryFeatureProvider(dictionary: ["obs": MLFeatureValue(multiArray: input)])
        for _ in 0..<3 { _ = try model.prediction(from: features) }
        let t = Date()
        let calls = 20
        for _ in 0..<calls { _ = try model.prediction(from: features) }
        let ms = Date().timeIntervalSince(t) * 1000 / Double(calls)
        cells.append(String(format: "B=%d %.2f ms (%.1f µs/obs)", batch, ms, ms * 1000 / Double(batch)))
      }
      lines.append("\(name) (loaded in \(String(format: "%.1f", loaded)) s; ops on \(placement(name))): " + cells.joined(separator: ", "))
    }
    return lines.joined(separator: "\n")
  }

  /// Where Core ML plans to run the model's operations with these compute units (MLComputePlan), as counts by device.
  private func placement(_ name: String) -> String {
    let config = MLModelConfiguration()
    guard let units = try? Self.computeUnits(name) else { return "?" }
    config.computeUnits = units
    let done = DispatchSemaphore(value: 0)
    var summary = "unknown"
    Task {
      defer { done.signal() }
      guard let plan = try? await MLComputePlan.load(contentsOf: url, configuration: config),
            case let .program(program) = plan.modelStructure, let main = program.functions["main"] else { return }
      var counts: [String: Int] = [:]
      for op in main.block.operations where op.operatorName != "const" {
        let device = switch plan.deviceUsage(for: op)?.preferred {
        case .neuralEngine: "ANE"
        case .gpu: "GPU"
        case .cpu: "CPU"
        default: "?"
        }
        counts[device, default: 0] += 1
      }
      summary = counts.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
    }
    done.wait()
    return summary
  }
}

/// A request in the inference protocol: uint32 rows, uint32 nonzeros, uint32 rowEnds[rows], float32 values[nonzeros],
/// uint16 indices[nonzeros], little-endian.
private struct Request {
  let rows: Int
  let ends: [Int]
  let values: [Float32]
  let indices: [UInt16]

  init(_ body: Data) throws {
    guard body.count >= 8 else { throw SpikeError("short request") }
    let (rows, nonzeros): (Int, Int) = body.withUnsafeBytes { raw in
      (Int(UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 0, as: UInt32.self))),
       Int(UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 4, as: UInt32.self))))
    }
    guard body.count == 8 + 4 * rows + 6 * nonzeros else { throw SpikeError("request of \(body.count) bytes for \(rows) rows, \(nonzeros) nonzeros") }
    self.rows = rows
    (ends, values, indices) = body.withUnsafeBytes { raw in
      let ends = (0..<rows).map { Int(UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 8 + 4 * $0, as: UInt32.self))) }
      let v = 8 + 4 * rows
      let values = (0..<nonzeros).map { Float32(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: v + 4 * $0, as: UInt32.self))) }
      let i = v + 4 * nonzeros
      let indices = (0..<nonzeros).map { UInt16(littleEndian: raw.loadUnaligned(fromByteOffset: i + 2 * $0, as: UInt16.self)) }
      return (ends, values, indices)
    }
  }
}
