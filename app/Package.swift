// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Atlas",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "Atlas", path: "Sources/Atlas")]
)
