import Foundation
import CryptoKit

// 媒体与OTA共用的有界安全整数JSON；领域字段仍由各自合同核对。
enum IntegerJSON {
    private static func fail() -> GatewayError { .invalidResponse }
    static func parse(_ text: String, maxBytes: Int = 2_000_000, maxDepth: Int = 24, maxNodes: Int = 65536, allowFractionalNumbers: Bool = false) throws -> JSONValue {
        var parser = Parser(bytes: Array(text.utf8), maxBytes: maxBytes, maxDepth: maxDepth, maxNodes: maxNodes, allowFractionalNumbers: allowFractionalNumbers)
        return try parser.parse()
    }
    private struct Parser {
        let bytes: [UInt8]; let maxBytes: Int; let maxDepth: Int; let maxNodes: Int; let allowFractionalNumbers: Bool
        var p = 0; var nodes = 0
        mutating func ws() { while p < bytes.count && [9, 10, 13, 32].contains(bytes[p]) { p += 1 } }
        mutating func take(_ b: UInt8) -> Bool { ws(); if p < bytes.count && bytes[p] == b { p += 1; return true }; return false }
        mutating func string() throws -> String {
            ws(); let start = p
            guard p < bytes.count, bytes[p] == 34 else { throw fail() }; p += 1
            while p < bytes.count {
                let b = bytes[p]; p += 1
                if b == 92 { guard p < bytes.count else { throw fail() }; p += 1 }
                else if b == 34 { return try JSONDecoder().decode(String.self, from: Data(bytes[start..<p])) }
                else if b < 32 { throw fail() }
            }
            throw fail()
        }
        mutating func value(_ depth: Int) throws -> JSONValue {
            ws(); nodes += 1
            guard nodes <= maxNodes, depth <= maxDepth, p < bytes.count else { throw fail() }
            if take(123) {
                var values: [String: JSONValue] = [:]
                if !take(125) {
                    repeat { let key = try string(); guard values[key] == nil, take(58) else { throw fail() }; values[key] = try value(depth + 1) } while take(44)
                    guard take(125) else { throw fail() }
                }
                return .object(values)
            }
            if take(91) {
                var values: [JSONValue] = []
                if !take(93) { repeat { values.append(try value(depth + 1)) } while take(44); guard take(93) else { throw fail() } }
                return .array(values)
            }
            if bytes[p] == 34 { return .string(try string()) }
            let start = p
            while p < bytes.count && ![44, 93, 125, 9, 10, 13, 32].contains(bytes[p]) { p += 1 }
            let token = String(decoding: bytes[start..<p], as: UTF8.self)
            switch token {
            case "true": return .bool(true)
            case "false": return .bool(false)
            case "null": return .null
            default:
                if allowFractionalNumbers {
                    guard token.range(of: #"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$"#, options: .regularExpression) != nil,
                          let number = Double(token), number.isFinite else { throw fail() }
                    if number.rounded(.towardZero) == number {
                        guard abs(number) <= 9007199254740991 else { throw fail() }; return .integer(Int(number))
                    }
                    return .number(number)
                }
                guard token.count <= 32, token.range(of: #"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$"#, options: .regularExpression) != nil,
                      let decimal = Decimal(string: token, locale: Locale(identifier: "en_US_POSIX")) else { throw fail() }
                let integer = NSDecimalNumber(decimal: decimal).int64Value
                guard abs(decimal) <= Decimal(9007199254740991 as Int64), decimal == Decimal(integer) else { throw fail() }
                return .integer(Int(integer))
            }
        }
        mutating func parse() throws -> JSONValue {
            guard bytes.count <= maxBytes else { throw fail() }
            let result = try value(0); ws(); guard p == bytes.count, case .object = result else { throw fail() }; return result
        }
    }
    public static func canonical(_ value: JSONValue) -> String {
        switch value {
        case .object(let items): "{" + items.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.map { JSONValue.string($0).jsonText + ":" + canonical(items[$0]!) }.joined(separator: ",") + "}"
        case .array(let items): "[" + items.map(canonical).joined(separator: ",") + "]"
        default: value.jsonText
        }
    }
    public static func digest(_ value: JSONValue) -> String { "sha256:" + SHA256.hash(data: Data(canonical(value).utf8)).map { String(format: "%02x", $0) }.joined() }
}
