import CoreML
import Foundation

/// The policy network in Core ML (KeepsPolicy, made by training/keeps_bot/coreml.py): float16 observations [B, O] to
/// logits [B, 48], B one of the model's fixed batch sizes (the Neural Engine runs only fixed shapes), so each
/// request's rows are padded up to the next size, or cut into the largest.
///
/// Requests run in LANES at once, each with its own input buffers: while one is on the Neural Engine, another's
/// observations are being unpacked (MLModel's predictions are thread-safe). Two is enough for that overlap on any
/// device; more would only queue at the Neural Engine.
final class Inference {
  static let lanes = 2
  let metadata: [String: String]
  private let size: Int
  private let actions: Int
  private let batches: [Int]
  private let model: MLModel
  private let lock = NSLock()
  private let laneSlots = DispatchSemaphore(value: Inference.lanes)
  /// Each free lane's input arrays, by batch size (reused, zeroed before each use).
  private var freeLanes: [[Int: MLMultiArray]] = Array(repeating: [:], count: Inference.lanes)

  init() throws {
    guard let url = Bundle.main.url(forResource: "KeepsPolicy", withExtension: "mlmodelc") else { throw KeepsError("KeepsPolicy.mlmodelc isn't in the app") }
    let config = MLModelConfiguration()
    config.computeUnits = .cpuAndNeuralEngine
    model = try MLModel(contentsOf: url, configuration: config)
    metadata = model.modelDescription.metadata[.creatorDefinedKey] as? [String: String] ?? [:]
    guard let size = Int(metadata["observationSize"] ?? ""), let actions = Int(metadata["numActions"] ?? ""),
          case let batches = (metadata["batches"] ?? "").split(separator: ",").compactMap({ Int($0) }), !batches.isEmpty
    else { throw KeepsError("the model's metadata lacks its sizes: \(metadata)") }
    (self.size, self.actions, self.batches) = (size, actions, batches.sorted())
  }

  /// A request's logits (the inference protocol: rows, nonzeros, rowEnds, values, indices → float32 logits).
  func forward(_ body: Data) throws -> Data {
    // (Checked before a lane is taken: the rows are written into the model's input by these numbers.)
    let request = try Request(body, size: size)
    laneSlots.wait()
    lock.lock()
    var inputs = freeLanes.removeLast()
    lock.unlock()
    defer {
      lock.lock()
      freeLanes.append(inputs)
      lock.unlock()
      laneSlots.signal()
    }
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
      let result = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["obs": MLFeatureValue(multiArray: input)]))
      guard let logits = result.featureValue(for: "logits")?.multiArrayValue else { throw KeepsError("no logits") }
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
      start += n
    }
    return out
  }
}

/// A request in the inference protocol: uint32 rows, uint32 nonzeros, uint32 rowEnds[rows], float32 values[nonzeros],
/// uint16 indices[nonzeros], little-endian.
private struct Request {
  let rows: Int
  let ends: [Int]
  let values: [Float32]
  let indices: [UInt16]

  /// The request in `body`, for observations of `size` features: its row ends rising to its nonzeros, its indices
  /// under `size` (they say where each value is written).
  init(_ body: Data, size: Int) throws {
    guard body.count >= 8 else { throw KeepsError("short request") }
    let (rows, nonzeros): (Int, Int) = body.withUnsafeBytes { raw in
      (Int(UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 0, as: UInt32.self))),
       Int(UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 4, as: UInt32.self))))
    }
    guard body.count == 8 + 4 * rows + 6 * nonzeros else { throw KeepsError("request of \(body.count) bytes for \(rows) rows, \(nonzeros) nonzeros") }
    self.rows = rows
    (ends, values, indices) = body.withUnsafeBytes { raw in
      let ends = (0..<rows).map { Int(UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 8 + 4 * $0, as: UInt32.self))) }
      let v = 8 + 4 * rows
      let values = (0..<nonzeros).map { Float32(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: v + 4 * $0, as: UInt32.self))) }
      let i = v + 4 * nonzeros
      let indices = (0..<nonzeros).map { UInt16(littleEndian: raw.loadUnaligned(fromByteOffset: i + 2 * $0, as: UInt16.self)) }
      return (ends, values, indices)
    }
    guard zip([0] + ends, ends).allSatisfy({ $0 <= $1 }), (ends.last ?? 0) == nonzeros else {
      throw KeepsError("request's row ends don't rise to its \(nonzeros) nonzeros")
    }
    if let bad = indices.first(where: { Int($0) >= size }) { throw KeepsError("request's index \(bad) is past the observation's \(size) features") }
  }
}
