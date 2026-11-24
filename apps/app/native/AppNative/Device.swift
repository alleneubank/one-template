import UIKit

// each method is an async function in typescript: `await Device.info()`.
// one generates Device.d.swift.ts from these signatures.
@MainActor final class Device: PeachModule {
  init() {}

  func info() -> [String: String] {
    let device = UIDevice.current
    return [
      "language": "Swift",
      "model": device.model,
      "system": "\(device.systemName) \(device.systemVersion)",
    ]
  }
}
