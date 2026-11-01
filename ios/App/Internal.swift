import Foundation

/// What's only for us: the KEEPS_* switches at launch (for tests, the self-test, screenshots, looking into a game) and the
/// core's web view open to Safari's Web Inspector. Compiled into our own builds (Debug, and ios/sync.sh's unless
/// STORE=1); a build for the App Store has neither, so nothing in its environment changes what it does.
enum Internal {
  #if INTERNAL
  static let on = true
  static let environment = ProcessInfo.processInfo.environment
  #else
  static let on = false
  static let environment: [String: String] = [:]
  #endif
}
