// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AgentCity",
    platforms: [.macOS(.v13)],
    targets: [.executableTarget(name: "AgentCity", path: "Sources/AgentCity")]
)
