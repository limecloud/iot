import Foundation

private actor CompositionPersistenceGate {
    static let shared = CompositionPersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw CompositionError(code: "composition_busy") }; busy = true }
    func end() { busy = false }
}

public struct CompositionPreview: Sendable {
    public let compiled: CompositionCompiled
    public let document: JSONValue
    public let createdAt: Date
    public var expiresAt: Date { createdAt.addingTimeInterval(60) }
    public var json: String { CompositionJSON.canonical(document) }
}
public struct CompositionStatus: Sendable {
    public let record: CompositionRecord
    public let deployment: Deployment?
    public var message: String {
        if deployment != nil { return record.state == "acknowledged" ? "当前组合已启用" : "当前已启用，原提交结果仍待核实" }
        return record.state == "attempted" ? "暂未看到当前部署，原提交结果仍待核实" : "当前组合未启用"
    }
}

// 组合仅编译到现有规则；证明只驻留内存，部署前保存完整原请求，恢复不补发。
public actor CompositionClient {
    public let space: String
    private let gateway: GatewayClient, store: any SessionStore, now: @Sendable () -> Date
    private var previous: Data?, unconfirmedWrite: Data?
    private var loaded = false, blocked = false, busy = false, generation = 0, writePending = false
    private var proof: (CompositionPreview, Int, Int)?
    private var storageKey: String { gateway.origin + "#composition:" + space }
    public init(gateway: GatewayClient, store: any SessionStore, space: String, now: @escaping @Sendable () -> Date = Date.init) throws {
        try MediaJSON.id(.string(space)); self.gateway = gateway; self.store = store; self.space = space; self.now = now
    }
    public func invalidate() { generation += 1; proof = nil }
    private func locked<T: Sendable>(_ work: () async throws -> T) async throws -> T {
        guard !busy else { throw CompositionError(code: "composition_busy") }; busy = true; defer { busy = false }
        try await CompositionPersistenceGate.shared.begin()
        do { try Task.checkCancellation(); let result = try await work(); await CompositionPersistenceGate.shared.end(); return result }
        catch { await CompositionPersistenceGate.shared.end(); throw error }
    }
    private func load() async throws -> CompositionRecord? {
        guard !blocked else { throw CompositionError(code: "composition_record_unavailable") }
        try Task.checkCancellation()
        let data: Data?
        do { data = try await store.load(origin: storageKey) } catch { throw CompositionError(code: "composition_record_unavailable") }
        try Task.checkCancellation()
        guard !loaded || data == previous || writePending && data == unconfirmedWrite else { blocked = true; throw CompositionError(code: "composition_record_unavailable") }
        do {
            let record = try data.map { data -> CompositionRecord in
                guard let text = String(data: data, encoding: .utf8) else { throw CompositionError(code: "composition_record_unavailable") }
                return try CompositionRecord.parse(text, origin: gateway.origin, space: space)
            }
            loaded = true; previous = data; unconfirmedWrite = nil; writePending = false; return record
        } catch { blocked = true; throw CompositionError(code: "composition_record_unavailable") }
    }
    private func requireRecord() async throws -> CompositionRecord {
        guard let record = try await load() else { throw CompositionError(code: "composition_not_found") }; return record
    }
    private func save(_ body: JSONValue?) async throws -> CompositionRecord? {
        let record: CompositionRecord?
        if let body {
            var fields = try MediaJSON.object(body); fields.removeValue(forKey: "checksum"); fields["checksum"] = .string(CompositionJSON.digest(.object(fields)))
            record = try CompositionRecord.parse(CompositionJSON.canonical(.object(fields)), origin: gateway.origin, space: space)
        } else { record = nil }
        let data = record.map { Data($0.json.utf8) }
        do {
            try Task.checkCancellation()
            guard try await store.load(origin: storageKey) == previous else { throw CompositionError(code: "composition_record_unavailable") }
            try Task.checkCancellation(); unconfirmedWrite = data; writePending = true
            try await store.save(origin: storageKey, data: data); try Task.checkCancellation()
            guard try await store.load(origin: storageKey) == data else { throw CompositionError(code: "composition_record_unavailable") }
            try Task.checkCancellation()
        } catch is CancellationError { throw CancellationError() }
        catch { throw CompositionError(code: "composition_record_unavailable") }
        previous = data; unconfirmedWrite = nil; writePending = false; loaded = true; return record
    }
    private func current(_ context: Int, _ epoch: Int) async throws {
        let session = try await gateway.compositionSession()
        try Task.checkCancellation()
        guard context == generation, session == epoch else { throw CancellationError() }
    }
    private func models(_ compiled: CompositionCompiled, epoch: Int, context: Int) async throws {
        for role in compiled.package.roles {
            let id = compiled.bindings[role]!
            let device = try await gateway.compositionCall(space: space, suffix: "/devices/" + id, epoch: epoch)
            try await current(context, epoch)
            guard MediaJSON.member(device, "device_id") == .string(id), MediaJSON.member(device, "model_revision") == .string(compiled.package.modelRevision(role)), MediaJSON.member(device, "ready") == .bool(true) else { throw CompositionError(code: "composition_model_mismatch") }
        }
    }
    public func record() async throws -> CompositionRecord? { try await locked { try await load() } }
    public func plan(_ compiled: CompositionCompiled) async throws -> CompositionPreview {
        proof = nil; let context = generation
        return try await locked {
            guard try await load() == nil else { throw CompositionError(code: "composition_pending") }
            let epoch = try await gateway.compositionSession(); try await current(context, epoch)
            try await models(compiled, epoch: epoch, context: context)
            let validation = try await gateway.compositionCall(space: space, suffix: "/rules:validate", epoch: epoch, method: "POST", body: compiled.rule)
            try await current(context, epoch)
            let simulation = try await gateway.compositionCall(space: space, suffix: "/rules:simulate", epoch: epoch, method: "POST", body: MediaJSON.member(compiled.document, "simulation_input"))
            try await current(context, epoch)
            let rule = try compiled.typedRule
            let result: Simulation = try CompositionJSON.decode(simulation)
            guard MediaJSON.member(validation, "revision") == .string(compiled.revision) else { throw GatewayError.invalidResponse }
            try RuleProof.verify(result, rule: rule, valid: MediaJSON.member(validation, "valid") == .bool(true), validationRevision: compiled.revision)
            try await models(compiled, epoch: epoch, context: context)
            var document = try MediaJSON.object(compiled.document); let created = now()
            document["gateway_checked"] = .bool(true); document["gateway_origin"] = .string(gateway.origin); document["space_id"] = .string(space)
            document["checked_at"] = .string(SpeechJSON.timestamp(created)); document["validation"] = validation; document["simulation"] = simulation
            let preview = CompositionPreview(compiled: compiled, document: .object(document), createdAt: created)
            try Task.checkCancellation(); guard context == generation else { throw CancellationError() }
            proof = (preview, epoch, context); return preview
        }
    }
    public func deploy() async throws -> CompositionRecord {
        guard let (preview, epoch, context) = proof else { throw CompositionError(code: "composition_preview_required") }
        proof = nil
        return try await locked {
            let compiled = preview.compiled
            func fresh() throws { let time = now(); guard time >= preview.createdAt && time < preview.expiresAt else { throw CompositionError(code: "composition_preview_required") } }
            try fresh(); try await current(context, epoch)
            guard try await load() == nil else { throw CompositionError(code: "composition_pending") }
            try await models(compiled, epoch: epoch, context: context); try fresh(); try await current(context, epoch)
            let body = JSONValue.object(["version": .integer(1), "origin": .string(gateway.origin), "space_id": .string(space), "package": compiled.package.document, "bindings": .object(compiled.bindings.mapValues(JSONValue.string)), "instance_id": .string(compiled.instanceID), "rule_revision": .string(compiled.revision), "state": .string("attempted")])
            let original = try await save(body)!
            try fresh(); try await current(context, epoch)
            do {
                let deployment = try await gateway.compositionCall(space: space, suffix: "/rule-deployments", epoch: epoch, method: "POST", body: compiled.rule, createOnly: true)
                try await current(context, epoch); _ = try checked(deployment, compiled)
                var confirmed = try MediaJSON.object(original.document); confirmed["state"] = .string("acknowledged")
                return try await save(.object(confirmed))!
            } catch let error as GatewayError {
                if error.definitiveRejection {
                    try await current(context, epoch)
                    var rejected = try MediaJSON.object(original.document); rejected["state"] = .string("rejected"); _ = try await save(.object(rejected))
                }
                throw error
            }
        }
    }
    private func checked(_ value: JSONValue, _ compiled: CompositionCompiled, conflict: Bool = false) throws -> Deployment {
        guard MediaJSON.member(value, "revision") == .string(compiled.revision), RuleProof.equal(MediaJSON.member(value, "rule"), compiled.rule) else { throw conflict ? GatewayError.server("revision_conflict", 409) : GatewayError.invalidResponse }
        return try CompositionJSON.decode(value)
    }
    public func resolve() async throws -> CompositionStatus {
        try await locked {
            let record = try await requireRecord(), epoch = try await gateway.compositionSession(), context = generation
            let page = try await gateway.compositionCall(space: space, suffix: "/rule-deployments", epoch: epoch)
            try await current(context, epoch)
            let fields = try MediaJSON.object(page)
            guard case .array(let items) = fields["items"], fields["next_cursor"] == .null else { throw GatewayError.invalidResponse }
            var matches: [JSONValue] = []
            for item in items {
                let id = try MediaJSON.text(MediaJSON.member(MediaJSON.member(item, "rule"), "id")); if id == record.compiled.instanceID { matches.append(item) }
            }
            guard matches.count <= 1 else { throw GatewayError.invalidResponse }
            _ = try await requireRecord()
            return CompositionStatus(record: record, deployment: try matches.first.map { try checked($0, record.compiled, conflict: true) })
        }
    }
    public func prepareAnother() async throws {
        proof = nil
        try await locked {
            let record = try await requireRecord(); guard record.state != "attempted" else { throw CompositionError(code: "composition_pending") }
            _ = try await save(nil)
        }
    }
}
