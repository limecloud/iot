import Foundation
import LimeIoTKit

enum MediaFile {
    struct Selection: Sendable { let name: String; let data: Data }
    enum Failure: Error { case tooLarge }
    static func read(_ url: URL, maxBytes: Int = MediaChanges.maxAudioBytes) async throws -> Selection {
        guard (1...MediaChanges.maxAudioBytes).contains(maxBytes) else { throw Failure.tooLarge }
        let task = Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
            var data = Data()
            while data.count <= maxBytes {
                try Task.checkCancellation()
                let count = min(65536, maxBytes + 1 - data.count)
                guard let chunk = try file.read(upToCount: count), !chunk.isEmpty else { break }
                data.append(chunk)
            }
            try Task.checkCancellation()
            guard data.count <= maxBytes else { throw Failure.tooLarge }
            return Selection(name: url.lastPathComponent, data: data)
        }
        return try await withTaskCancellationHandler(operation: { let result = try await task.value; try Task.checkCancellation(); return result }, onCancel: { task.cancel() })
    }
}
