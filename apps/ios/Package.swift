// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LimeIoTKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "LimeIoTKit", targets: ["LimeIoTKit"])],
    targets: [
        .target(name: "LimeIoTKit", resources: [.process("Resources")]),
        .executableTarget(name: "ClientChecks", dependencies: ["LimeIoTKit"], path: "Tests/LimeIoTKitTests")
    ]
)
