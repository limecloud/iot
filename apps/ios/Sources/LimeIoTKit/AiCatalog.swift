import Foundation

public enum AiCapability: String, CaseIterable, Sendable, Identifiable {
    case ruleDraft = "automation.rule_draft", text = "text.generate", vision = "vision.understand", transcription = "audio.transcribe", speech = "audio.synthesize"
    public var id: String { rawValue }
}
public struct AiCatalogError: Error, Sendable { public let code = "invalid_ai_catalog" }
public struct AiCatalogEntry: Sendable, Identifiable {
    public let capability: AiCapability
    public let definition: JSONValue
    public let deployment: JSONValue?
    public var id: String { capability.rawValue }
    public var configured: Bool { deployment != nil }
    public var model: String? { deployment.map { MediaJSON.string(MediaJSON.member($0, "identity"), "model") } }
    public var revision: String? { deployment.flatMap { value in
        let revision = MediaJSON.member(MediaJSON.member(value, "identity"), "revision")
        return revision == .null ? nil : try? MediaJSON.text(revision)
    } }
    public var configuration: [String: JSONValue]? { deployment.flatMap { try? MediaJSON.object(MediaJSON.member($0, "configuration")) } }
}
public struct AiCatalog: Sendable {
    public let document: JSONValue
    public let entries: [AiCatalogEntry]
    public static func parse(_ raw: String, space: String) throws -> AiCatalog {
        do { return try AiCatalogJSON.checked(IntegerJSON.parse(raw, maxBytes: 32768, maxDepth: 8, maxNodes: 2048), space: space) }
        catch { throw AiCatalogError() }
    }
}

enum AiCatalogJSON {
    private static func definition(_ kind: AiCapability, _ inputs: [String], _ outputs: [String], _ schema: String, _ task: String?, _ operation: String) -> JSONValue {
        .object(["capability_id": .string(kind.rawValue), "input_modalities": .array(inputs.map(JSONValue.string)), "output_modalities": .array(outputs.map(JSONValue.string)), "input_schema": .string(schema), "task_schema": task.map(JSONValue.string) ?? .null, "create_operation": .string(operation + ".create"), "resolve_operation": .string(operation + ".resolve"), "streaming": .bool(false), "tool_calling": .bool(false), "structured_output": .bool(kind == .ruleDraft), "device_execution": .bool(false)])
    }
    private static let definitions: [JSONValue] = [
        definition(.ruleDraft, ["text", "device_context"], ["rule"], "draft-request", nil, "drafts"),
        definition(.text, ["text"], ["text"], "text", "text#/$defs/task", "text-generations"),
        definition(.vision, ["image", "text"], ["text"], "vision", "vision#/$defs/task", "vision-observations"),
        definition(.transcription, ["audio"], ["text"], "transcription", "transcription#/$defs/task", "audio-transcriptions"),
        definition(.speech, ["text"], ["audio"], "speech", "speech#/$defs/task", "speech-syntheses")
    ]
    static func checked(_ value: JSONValue, space: String) throws -> AiCatalog {
        do {
            try MediaJSON.require(space.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil)
            let v = try MediaJSON.fields(value, "schema_version,space_id,definitions,deployments,health,routing")
            try MediaJSON.require(v["schema_version"] == .integer(1) && v["space_id"] == .string(space) && v["definitions"] == .array(definitions))
            try MediaJSON.require(v["routing"] == .object(["selection": .string("fixed_configuration"), "automatic_fallback": .bool(false)]))
            guard case .array(let deployments) = v["deployments"], deployments.count <= 5, case .array(let health) = v["health"], health.count == 5 else { throw AiCatalogError() }
            var deployed: [AiCapability: JSONValue] = [:]
            for raw in deployments {
                let item = try MediaJSON.fields(raw, "capability_id,identity,configuration,license,cost_policy,resource_requirements,quality")
                guard let kind = AiCapability(rawValue: try MediaJSON.text(item["capability_id"])) else { throw AiCatalogError() }
                try MediaJSON.require(deployed[kind] == nil && ["license", "cost_policy", "resource_requirements", "quality"].allSatisfy { item[$0] == .null })
                var config = try MediaJSON.object(item["configuration"])
                try MediaJSON.require(["configured", "capability", "deployment"].allSatisfy { config[$0] == nil })
                let identity = item["identity"]!
                config["configured"] = .bool(true); config["capability"] = .string(kind.rawValue); config["deployment"] = identity
                switch kind {
                case .text: _ = try TextGenerationJSON.capabilities(.object(config))
                case .vision: _ = try VisionJSON.capabilities(.object(config))
                case .transcription: _ = try TranscriptionJSON.capabilities(.object(config))
                case .speech: _ = try SpeechJSON.capabilities(.object(config))
                case .ruleDraft:
                    let i = try MediaJSON.fields(identity, "adapter,revision,model,data_location")
                    try MediaJSON.require(i["adapter"] == .string("ollama") && i["revision"] == .null && i["data_location"] == .string("local"))
                    try MediaJSON.require(MediaJSON.text(i["model"]).range(of: #"^[A-Za-z0-9_:./-]{1,128}$"#, options: .regularExpression) != nil)
                    try MediaJSON.require(item["configuration"] == .object(["concurrency": .integer(1), "max_output_tokens": .integer(1024)]))
                }
                deployed[kind] = raw
            }
            var observed: Set<AiCapability> = []
            for raw in health {
                let item = try MediaJSON.fields(raw, "capability_id,status,checked_at")
                guard let kind = AiCapability(rawValue: try MediaJSON.text(item["capability_id"])) else { throw AiCatalogError() }
                try MediaJSON.require(observed.insert(kind).inserted && item["checked_at"] == .null && item["status"] == .string(deployed[kind] == nil ? "not_configured" : "unknown"))
            }
            return AiCatalog(document: value, entries: AiCapability.allCases.enumerated().map { i, kind in AiCatalogEntry(capability: kind, definition: definitions[i], deployment: deployed[kind]) })
        } catch { throw AiCatalogError() }
    }
}
