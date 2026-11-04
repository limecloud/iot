import Foundation

public enum PcmRecording {
    public static let sampleRate = 16000
    public static let maxSeconds = 60
    public static let maxFrames = sampleRate * maxSeconds
    public static let maxBytes = 44 + maxFrames * 2

    public static func encode(_ samples: [Int16]) throws -> Data {
        guard !samples.isEmpty, samples.count <= maxFrames else { throw MediaError(code: "invalid_media_audio") }
        var bytes = Data()
        bytes.reserveCapacity(44 + samples.count * 2)
        func text(_ value: String) { bytes.append(contentsOf: value.utf8) }
        func integer<T: FixedWidthInteger>(_ value: T) { var little = value.littleEndian; withUnsafeBytes(of: &little) { bytes.append(contentsOf: $0) } }
        text("RIFF"); integer(UInt32(36 + samples.count * 2)); text("WAVEfmt "); integer(UInt32(16))
        integer(UInt16(1)); integer(UInt16(1)); integer(UInt32(sampleRate)); integer(UInt32(sampleRate * 2))
        integer(UInt16(2)); integer(UInt16(16)); text("data"); integer(UInt32(samples.count * 2))
        for sample in samples { integer(sample) }
        _ = try MediaChanges.upload(bytes: bytes, retainSeconds: 600)
        return bytes
    }
}
