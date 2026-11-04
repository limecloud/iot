import Foundation

private actor ObservationPersistenceGate {
    static let shared = ObservationPersistenceGate()
    private var busy = false
    func begin() throws { guard !busy else { throw ObservationError(code: "observation_busy") }; busy = true }
    func end() { busy = false }
}

public actor ObservationClient {
    private let gateway: GatewayClient
    private let store: any SessionStore
    private let origin: String
    private var previous: Data?, loaded = false, busy = false
    public init(gateway: GatewayClient, store: any SessionStore) { self.gateway = gateway; self.store = store; origin = gateway.origin }
    private var storageKey: String { origin + "#observation-operations" }
    private func locked<T: Sendable>(_ action: () async throws -> T) async throws -> T {
        guard !busy else { throw ObservationError(code: "observation_busy") }; busy = true; defer { busy = false }
        try await ObservationPersistenceGate.shared.begin()
        do { let result = try await action(); await ObservationPersistenceGate.shared.end(); return result }
        catch { await ObservationPersistenceGate.shared.end(); throw error }
    }
    private func load() async throws -> [ObservationRecord] {
        let data: Data?
        do { data = try await store.load(origin: storageKey) } catch is CancellationError { throw CancellationError() } catch { throw ObservationError(code: "observation_storage_failed") }
        guard !loaded || previous == data else { throw ObservationError(code: "observation_record_changed") }
        var records: [ObservationRecord] = []
        if let data {
            do {
                guard let text = String(data: data, encoding: .utf8) else { throw ObservationJSON.fail() }
                let state = try ObservationJSON.fields(ObservationJSON.parse(text, response: true), "version,origin,records")
                try ObservationJSON.require(state["version"] == .integer(1) && state["origin"] == .string(origin))
                guard case .array(let items) = state["records"], items.count <= 128 else { throw ObservationJSON.fail() }
                for item in items {
                    let r = try ObservationJSON.fields(item, "request,result"); try ObservationJSON.request(r["request"]!)
                    let result = r["result"] == .null ? nil : r["result"]
                    if let result { try ObservationJSON.operation(result, expected: r["request"]!) }
                    records.append(ObservationRecord(request: r["request"]!, result: result))
                }
                try ObservationJSON.require(Set(records.map { ObservationJSON.string($0.request, "space_id") + ":" + $0.id }).count == records.count)
            } catch { throw ObservationError(code: "observation_storage_failed") }
        }
        previous = data; loaded = true; return records
    }
    private func persist(_ records: [ObservationRecord]) async throws {
        let value = JSONValue.object(["version": .integer(1), "origin": .string(origin), "records": .array(records.map { .object(["request": $0.request, "result": $0.result ?? .null]) })])
        let data = Data(ObservationJSON.canonical(value).utf8)
        do { _ = try ObservationJSON.parse(String(decoding: data, as: UTF8.self), response: true) } catch { throw ObservationError(code: "observation_capacity") }
        do {
            guard try await store.load(origin: storageKey) == previous else { throw ObservationError(code: "observation_record_changed") }
            try await store.save(origin: storageKey, data: data)
            guard try await store.load(origin: storageKey) == data else { throw ObservationError(code: "observation_storage_failed") }
        } catch is CancellationError { throw CancellationError() } catch let error as ObservationError { throw error } catch { throw ObservationError(code: "observation_storage_failed") }
        previous = data; loaded = true
    }
    public func records(space: String) async throws -> [ObservationRecord] {
        try ObservationJSON.id(.string(space))
        return try await locked { try await load().filter { ObservationJSON.string($0.request, "space_id") == space } }
    }
    public func candidates(space: String) async throws -> ObservationCandidates {
        try ObservationJSON.id(.string(space)); return try ObservationJSON.candidates(await gateway.observationCall(space: space, suffix: "/observation-candidates"))
    }
    public func query(space: String, coordinator: String, ieee: String, endpoint: Int, profile: ObservationProfile = .environment) async throws -> ObservationCandidate {
        try ObservationJSON.id(.string(space)); let input = try ObservationJSON.query(coordinator: coordinator, ieee: ieee, endpoint: endpoint, profile: profile)
        let catalog = try await candidates(space: space)
        guard let selected = catalog.coordinators.first(where: { $0.id == coordinator }) else { throw ObservationJSON.fail() }
        let candidate = try ObservationJSON.candidate(await gateway.observationCall(space: space, suffix: "/observation-candidates", method: "POST", body: input, query: true))
        try ObservationJSON.require(candidate.profile == profile && candidate.ieee == ieee && candidate.endpoint == endpoint && ObservationJSON.string(ObservationJSON.map(candidate.document)["target"], "coordinator_ieee") == selected.ieee)
        return candidate
    }
    public func binding(space: String, device: String) async throws -> ObservationBinding {
        try ObservationJSON.id(.string(space)); try ObservationJSON.id(.string(device))
        return try ObservationJSON.binding(await gateway.observationCall(space: space, suffix: "/devices/" + device + "/observation-binding"), device: device)
    }
    public func discover(space: String, coordinator: String) async throws -> ObservationDiscovery {
        let input = try ObservationDiscoveryJSON.query(coordinator: coordinator)
        let catalog = try await candidates(space: space)
        guard let selected = catalog.coordinators.first(where: { $0.id == coordinator }) else { throw ObservationJSON.fail() }
        return try ObservationDiscoveryJSON.discovery(await gateway.observationCall(space: space, suffix: "/observation-discoveries", method: "POST", body: input, query: true), coordinator: selected)
    }
    public func endpoints(space: String, coordinator: String, ieee: String) async throws -> ObservationEndpoints {
        let input = try ObservationDiscoveryJSON.query(coordinator: coordinator, ieee: ieee)
        let catalog = try await candidates(space: space)
        guard let selected = catalog.coordinators.first(where: { $0.id == coordinator }) else { throw ObservationJSON.fail() }
        return try ObservationDiscoveryJSON.endpoints(await gateway.observationCall(space: space, suffix: "/observation-endpoints", method: "POST", body: input, query: true), coordinator: selected, ieee: ieee)
    }
    public func submit(space: String, change: JSONValue, key: String = UUID().uuidString.lowercased()) async throws -> ObservationRecord {
        try await locked {
            let checked = try ObservationJSON.parse(ObservationJSON.canonical(change)); try ObservationJSON.change(checked)
            try ObservationJSON.id(.string(space)); try ObservationJSON.id(.string(key))
            let request = JSONValue.object(["space_id": .string(space), "idempotency_key": .string(key), "change": checked]), records = try await load()
            if let old = records.first(where: { $0.id == key && ObservationJSON.string($0.request, "space_id") == space }) {
                try ObservationJSON.require(old.request == request); return try await resolveSaved(records, old)
            }
            guard records.count < 128 else { throw ObservationError(code: "observation_capacity") }
            let device = ObservationJSON.string(checked, "device_id"), source = ObservationJSON.string(ObservationJSON.map(checked)["source"], "adapter_id")
            for record in records where record.pending && ObservationJSON.string(record.request, "space_id") == space {
                let oldChange = ObservationJSON.map(record.request)["change"]
                if record.device == device || !source.isEmpty && ObservationJSON.string(ObservationJSON.map(oldChange)["source"], "adapter_id") == source { throw ObservationError(code: "observation_pending_operation") }
            }
            let record = ObservationRecord(request: request, result: nil), next = records + [record]
            try await persist(next); try Task.checkCancellation()
            let result = try await gateway.observationCall(space: space, suffix: "/observation-operations", method: "POST", body: checked, key: key)
            try ObservationJSON.operation(result, expected: request)
            let resolved = ObservationRecord(request: request, result: result)
            try await persist(next.map { $0.request == request ? resolved : $0 }); return resolved
        }
    }
    private func resolveSaved(_ records: [ObservationRecord], _ record: ObservationRecord) async throws -> ObservationRecord {
        let result = try await gateway.observationCall(space: ObservationJSON.string(record.request, "space_id"), suffix: "/observation-operations/by-key/" + record.id)
        try ObservationJSON.operation(result, expected: record.request); try ObservationJSON.require(record.result == nil || record.result == result)
        let resolved = ObservationRecord(request: record.request, result: result)
        try await persist(records.map { $0.request == record.request ? resolved : $0 }); return resolved
    }
    public func resolve(space: String, key: String) async throws -> ObservationRecord {
        try ObservationJSON.id(.string(space)); try ObservationJSON.id(.string(key))
        return try await locked {
            let records = try await load()
            guard let record = records.first(where: { $0.id == key && ObservationJSON.string($0.request, "space_id") == space }) else { throw ObservationError(code: "observation_record_missing") }
            return try await resolveSaved(records, record)
        }
    }
}
