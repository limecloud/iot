import Foundation
import LimeIoTKit

private enum Failure: Error { case check(String) }
private func check(_ value: @autoclosure () throws -> Bool, _ label: String) throws { if try !value() { throw Failure.check(label) } }
private func object(_ value: JSONValue) throws -> [String: JSONValue] { guard case .object(let v) = value else { throw Failure.check("object") }; return v }
private func string(_ value: JSONValue?) throws -> String { guard case .string(let v) = value else { throw Failure.check("string") }; return v }
private func array(_ value: JSONValue?) throws -> [JSONValue] { guard case .array(let v) = value else { throw Failure.check("array") }; return v }
private func rejects(_ label: String, _ work: () throws -> Void) throws { do { try work() } catch { return }; throw Failure.check("accepted: " + label) }

@main struct CompositionChecks {
    static func main() async throws {
        let fixture = try object(JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))))
        let origin = try string(fixture["origin"]), space = try string(fixture["space_id"])
        let cases = try array(fixture["cases"])
        for item in cases {
            let v = try object(item), name = try string(v["name"])
            let package = try CompositionPackage.parse(string(v["package_text"]))
            let bindings = try object(v["bindings"]!).mapValues { try string($0) }
            let compiled = try package.compile(bindings: bindings, instanceID: string(v["instance_id"]))
            try check(compiled.json == string(v["compiled_json"]), "JS compile parity: " + name)
            try rejects("duplicate binding") { _ = try package.compile(bindings: ["touch": "same", "light": "same"], instanceID: "id") }
            try rejects("unsafe device") { _ = try package.compile(bindings: ["touch": "x/y", "light": "device-lamp"], instanceID: "id") }
        }
        for value in try array(fixture["records"]) {
            let text = try string(value), record = try CompositionRecord.parse(text, origin: origin, space: space)
            try check(record.json == text, "record parity")
            try rejects("other origin") { _ = try CompositionRecord.parse(text, origin: "https://other.local", space: space) }
            try rejects("other space") { _ = try CompositionRecord.parse(text, origin: origin, space: "another") }
        }
        for value in try array(fixture["invalid_packages"]) { try rejects("invalid package") { _ = try CompositionPackage.parse(string(value)) } }
        for value in try array(fixture["invalid_records"]) { try rejects("invalid record") { _ = try CompositionRecord.parse(string(value), origin: origin, space: space) } }
        print("Swift组合合同通过：\(cases.count)组JS编译向量、三种原提交状态及损坏/上下文/绑定边界")
    }
}
