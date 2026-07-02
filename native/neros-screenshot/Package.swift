// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "neros-screenshot",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "neros-screenshot", path: "Sources"),
    ]
)
