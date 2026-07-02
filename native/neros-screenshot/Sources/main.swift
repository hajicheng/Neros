import AppKit
import Foundation
@preconcurrency import ScreenCaptureKit

@MainActor
func captureScreen(
    format: String,
    outputPath: String,
    maxWidth: Int,
    quality: Double,
    screenIndex: Int?
) async throws -> (width: Int, height: Int) {
    let content = try await SCShareableContent.current
    let displays = content.displays.sorted { $0.displayID < $1.displayID }
    guard !displays.isEmpty else {
        throw CaptureError.noDisplays
    }

    let idx = screenIndex ?? 0
    guard idx >= 0 && idx < displays.count else {
        throw CaptureError.noDisplays
    }
    let display = displays[idx]

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = SCStreamConfiguration()

    let scale = display.width > maxWidth
        ? Double(maxWidth) / Double(display.width)
        : 1.0
    let targetWidth = Int((Double(display.width) * scale).rounded())
    let targetHeight = Int((Double(display.height) * scale).rounded())
    config.width = targetWidth
    config.height = targetHeight
    config.showsCursor = true

    let cgImage = try await SCScreenshotManager.captureImage(
        contentFilter: filter,
        configuration: config
    )

    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    let data: Data
    if format == "png" {
        guard let encoded = bitmap.representation(using: .png, properties: [:]) else {
            throw CaptureError.encodeFailed
        }
        data = encoded
    } else {
        guard let encoded = bitmap.representation(
            using: .jpeg,
            properties: [.compressionFactor: quality]
        ) else {
            throw CaptureError.encodeFailed
        }
        data = encoded
    }

    let url = URL(fileURLWithPath: outputPath)
    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try data.write(to: url)

    return (width: cgImage.width, height: cgImage.height)
}

enum CaptureError: LocalizedError {
    case noDisplays
    case encodeFailed

    var errorDescription: String? {
        switch self {
        case .noDisplays: "No displays available"
        case .encodeFailed: "Failed to encode image"
        }
    }
}

struct Main {
    static func main() async {
        var format = "jpg"
        var outputPath = ""
        var maxWidth = 1280
        var quality = 0.65
        var screenIndex: Int? = nil

        let args = CommandLine.arguments
        var i = 1
        while i < args.count {
            switch args[i] {
            case "--format":
                i += 1; if i < args.count { format = args[i] }
            case "--output":
                i += 1; if i < args.count { outputPath = args[i] }
            case "--max-width":
                i += 1; if i < args.count { maxWidth = Int(args[i]) ?? 1280 }
            case "--quality":
                i += 1; if i < args.count { quality = Double(args[i]) ?? 0.65 }
            case "--screen-index":
                i += 1; if i < args.count { screenIndex = Int(args[i]) }
            default: break
            }
            i += 1
        }

        guard !outputPath.isEmpty else {
            let err = ["error": "missing --output"]
            FileHandle.standardError.write(Data((try! JSONSerialization.data(withJSONObject: err))))
            exit(1)
        }

        do {
            let size = try await captureScreen(
                format: format,
                outputPath: outputPath,
                maxWidth: maxWidth,
                quality: quality,
                screenIndex: screenIndex
            )
            let result: [String: Any] = [
                "path": outputPath,
                "width": size.width,
                "height": size.height,
            ]
            let json = try JSONSerialization.data(withJSONObject: result)
            FileHandle.standardOutput.write(json)
            exit(0)
        } catch {
            let err: [String: Any] = ["error": error.localizedDescription]
            let json = try! JSONSerialization.data(withJSONObject: err)
            FileHandle.standardError.write(json)
            exit(1)
        }
    }
}

await Main.main()
