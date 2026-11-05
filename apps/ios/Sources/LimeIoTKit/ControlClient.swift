import CryptoKit
import Foundation

public actor ControlClient {
    private struct Failure: Decodable { struct Detail: Decodable { let code: String }; let error: Detail }
    public nonisolated let origin: String
    private let transport: any HTTPTransport
    private let store: any SessionStore
    private var state: ControlState?
    private var busy = false
    private var storageKey: String { "limeiot.control:v1:" + origin }
    public init(endpoint: String, store: any SessionStore, transport: any HTTPTransport = URLSessionTransport(), allowLoopbackHTTP: Bool = false) throws {
        guard let parts = URLComponents(string: endpoint), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil, parts.path.isEmpty,
              parts.scheme == "https" || (allowLoopbackHTTP && parts.scheme == "http" && ["127.0.0.1", "::1", "[::1]"].contains(host)),
              parts.url?.absoluteString == endpoint else { throw ControlError.invalidEndpoint }
        origin = endpoint; self.store = store; self.transport = transport
    }
    private static func encoder() -> JSONEncoder { let v = JSONEncoder(); v.keyEncodingStrategy = .convertToSnakeCase; return v }
    private static func decoder() -> JSONDecoder { let v = JSONDecoder(); v.keyDecodingStrategy = .convertFromSnakeCase; return v }
    private static func random() -> String { (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }
    private static func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) == (value.startIndex..<value.endIndex) }
    private static func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    private static func challenge(_ verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func date(_ value: String) -> Date? {
        let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = format.date(from: value) { return date }
        format.formatOptions = [.withInternetDateTime]; return format.date(from: value)
    }
    private func acquire() throws { guard !busy else { throw ControlError.busy }; busy = true }
    private func load() async throws -> ControlState {
        if let state { return state }
        guard let data = try await store.load(origin: storageKey) else { return ControlState(version: 1, origin: origin) }
        let decoded = try Self.decoder().decode(ControlState.self, from: data)
        guard decoded.version == 1 && decoded.origin == origin else { throw ControlError.invalidResponse }
        if let pending = decoded.pending {
            guard Self.matches(pending.proof.requestKey, "^[a-f0-9]{64}$"), Self.matches(pending.proof.codeVerifier, "^[A-Za-z0-9._~-]{43,128}$"), ["ios", "android", "macos", "windows"].contains(pending.platform) else { throw ControlError.invalidResponse }
            if let login = pending.login { try validate(login) }
        }
        if let material = decoded.material { try validate(material, requireFuture: false) }
        let records = decoded.operations ?? []
        guard records.count <= 128, Set(records.map(\.id)).count == records.count,
              records.allSatisfy({ $0.reference.origin == origin && Self.matches($0.id, "^[a-f0-9]{64}$") }) else { throw ControlError.invalidResponse }
        state = decoded; return decoded
    }
    private func persist(_ next: ControlState) async throws {
        try Task.checkCancellation()
        try await store.save(origin: storageKey, data: Self.encoder().encode(next))
        state = next
    }
    private func validate(_ login: NativeLogin) throws {
        guard Self.matches(login.authorizationId, "^na-[a-f0-9]{64}$"), Self.matches(login.userCode, "^[A-F0-9]{8}$"),
              login.verificationUri == origin + "/console/?native=" + login.authorizationId,
              login.intervalSeconds == 3, Self.date(login.expiresAt) != nil else { throw ControlError.invalidResponse }
    }
    private func validate(_ material: ControlMaterial, requireFuture: Bool = true) throws {
        guard material.version == 1 && material.origin == origin && material.audience == "console",
              Self.matches(material.session, "^[a-f0-9]{64}$"), Self.matches(material.principalId, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"),
              let expires = Self.date(material.expiresAt), !requireFuture || expires > .now && expires.timeIntervalSinceNow <= 3630 else { throw ControlError.invalidResponse }
    }
    private func http<T: Decodable & Sendable>(_ path: String, input: Data? = nil, material: ControlMaterial? = nil) async throws -> T {
        var request = URLRequest(url: URL(string: origin + path)!, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.httpMethod = input == nil ? "GET" : "POST"; request.httpBody = input
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if input != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let material {
            request.setValue(origin, forHTTPHeaderField: "Origin")
            request.setValue((origin.hasPrefix("https:") ? "__Host-limeiot_console=" : "limeiot_console=") + material.session, forHTTPHeaderField: "Cookie")
            request.setValue(Self.hash("limeiot-csrf:console:" + material.session), forHTTPHeaderField: "X-CSRF-Token")
        }
        try Task.checkCancellation()
        let (data, response) = try await transport.send(request)
        try Task.checkCancellation()
        guard response.url?.absoluteString == request.url?.absoluteString, data.count <= 262144 else { throw ControlError.invalidResponse }
        guard response.statusCode == 200 else {
            let code = (try? Self.decoder().decode(Failure.self, from: data).error.code) ?? "invalid_response"
            if response.statusCode == 401 && material != nil {
                var next = try await load(); next.material = nil; try await persist(next)
                throw ControlError.unauthenticated
            }
            throw ControlError.server(code, response.statusCode)
        }
        do { return try Self.decoder().decode(T.self, from: data) } catch { throw ControlError.invalidResponse }
    }
    private func current(_ material: ControlMaterial) async throws -> ControlSession {
        try validate(material, requireFuture: false)
        let session: ControlSession = try await http("/api/console/v1/auth/session", material: material)
        guard session.audience == "console", session.principal.principalId == material.principalId,
              session.csrfToken == Self.hash("limeiot-csrf:console:" + material.session),
              let expires = Self.date(session.expiresAt), expires > .now,
              let originalExpiry = Self.date(material.expiresAt), abs(expires.timeIntervalSince(originalExpiry)) <= 1 else { throw ControlError.invalidResponse }
        return session
    }
    public func beginAuthorization(platform: String = "ios") async throws -> NativeLogin {
        try acquire(); defer { busy = false }
        var next = try await load()
        guard next.material == nil else { throw ControlError.alreadyAuthenticated }
        guard ["ios", "android", "macos", "windows"].contains(platform) else { throw ControlError.invalidResponse }
        if next.pending == nil {
            next.pending = NativePending(proof: NativeProof(requestKey: Self.random(), codeVerifier: Self.random()), platform: platform)
            try await persist(next)
        }
        guard let pending = next.pending, pending.platform == platform else { throw ControlError.invalidResponse }
        struct Input: Encodable { let requestKey: String; let codeChallenge: String; let platform: String }
        let login: NativeLogin = try await http("/api/native/v1/authorizations", input: Self.encoder().encode(Input(requestKey: pending.proof.requestKey, codeChallenge: Self.challenge(pending.proof.codeVerifier), platform: platform)))
        try validate(login)
        if let original = pending.login { guard original.authorizationId == login.authorizationId && original.userCode == login.userCode && original.expiresAt == login.expiresAt else { throw ControlError.invalidResponse } }
        next.pending?.login = login; try await persist(next); return login
    }
    public func pollAuthorization() async throws -> NativeLoginResult {
        try acquire(); defer { busy = false }
        var next = try await load()
        guard let pending = next.pending else { throw ControlError.authorizationRequired }
        struct Poll: Decodable, Sendable { let status: NativeAuthorizationStatus; let expiresAt: String; let material: ControlMaterial? }
        let value: Poll = try await http("/api/native/v1/authorizations/poll", input: Self.encoder().encode(pending.proof))
        guard let expiry = Self.date(value.expiresAt), expiry > .now, pending.login == nil || pending.login?.expiresAt == value.expiresAt else { throw ControlError.invalidResponse }
        guard value.status == .approved else {
            guard value.material == nil else { throw ControlError.invalidResponse }
            return NativeLoginResult(status: value.status, session: nil)
        }
        guard let material = value.material else { throw ControlError.invalidResponse }
        try validate(material)
        let session = try await current(material)
        next.material = material; try await persist(next)
        return NativeLoginResult(status: .approved, session: session)
    }
    public func cancelAuthorization() async throws {
        try acquire(); defer { busy = false }
        var next = try await load()
        guard let pending = next.pending else { throw ControlError.authorizationRequired }
        struct Cancelled: Decodable, Sendable { let status: NativeAuthorizationStatus }
        let value: Cancelled = try await http("/api/native/v1/authorizations/cancel", input: Self.encoder().encode(pending.proof))
        guard value.status == .cancelled else { throw ControlError.invalidResponse }
        next.pending = nil; next.material = nil; try await persist(next)
    }
    public func hasPendingAuthorization() async throws -> Bool {
        try acquire(); defer { busy = false }
        return try await load().pending != nil
    }
    public func restoreSession() async throws -> ControlSession {
        try acquire(); defer { busy = false }
        guard let material = try await load().material else { throw ControlError.unauthenticated }
        return try await current(material)
    }
    public func logout() async throws {
        try acquire(); defer { busy = false }
        var next = try await load()
        guard let material = next.material else { throw ControlError.unauthenticated }
        struct Logout: Decodable, Sendable { let loggedOut: Bool }
        let result: Logout = try await http("/api/console/v1/auth/logout", input: Data("{}".utf8), material: material)
        guard result.loggedOut else { throw ControlError.invalidResponse }
        next.material = nil; next.pending = nil; try await persist(next)
    }
    private func authenticated<T: Decodable & Sendable>(_ path: String) async throws -> T {
        guard let material = try await load().material else { throw ControlError.unauthenticated }
        _ = try await current(material)
        return try await http(path, material: material)
    }
    private static func segment(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_")))! }
    public func spaces() async throws -> [ControlSpace] {
        try acquire(); defer { busy = false }
        struct Spaces: Decodable, Sendable { let spaces: [ControlSpace] }
        let result: Spaces = try await authenticated("/api/console/v1/spaces"); return result.spaces
    }
    public func gateways(space: String) async throws -> [ControlGateway] {
        try acquire(); defer { busy = false }
        struct Gateways: Decodable, Sendable { let gateways: [ControlGateway] }
        let result: Gateways = try await authenticated("/api/console/v1/spaces/" + Self.segment(space) + "/gateways"); return result.gateways
    }
    public func devices(space: String, after: String? = nil) async throws -> ControlDevicePage {
        try acquire(); defer { busy = false }
        return try await authenticated("/api/console/v1/spaces/" + Self.segment(space) + "/devices" + (after.map { "?after=" + Self.segment($0) } ?? ""))
    }
    public func model(space: String, revision: String) async throws -> Model {
        try acquire(); defer { busy = false }
        struct Release: Decodable, Sendable { let revision: String; let model: Model }
        let result: Release = try await authenticated("/api/console/v1/spaces/" + Self.segment(space) + "/model-releases/" + Self.segment(revision))
        guard result.revision == revision else { throw ControlError.invalidResponse }; return result.model
    }
    public func prepareCommand(space: String, gateway: ControlGateway, device: Device, path: String, value: JSONValue, type: String = "property.set") async throws -> ControlCommandRecord {
        try acquire(); defer { busy = false }
        var next = try await load()
        guard let material = next.material else { throw ControlError.unauthenticated }
        let session = try await current(material)
        guard gateway.spaceId == space, gateway.principalId == session.principal.principalId, gateway.active,
              gateway.scopes.contains("commands.write") else { throw ControlError.server("forbidden", 403) }
        guard device.ready else { throw ControlError.server("device_offline", 409) }
        guard ["property.set", "action.invoke"].contains(type), Self.matches(path, "^[a-z][a-z0-9_-]{0,63}\\.[a-z][a-z0-9_-]{0,63}$") else { throw ControlError.invalidResponse }
        var records = next.operations ?? []
        guard records.count < 128 else { throw ControlError.server("local_operation_capacity", 429) }
        let operation = try Self.decoder().decode(Operation.self, from: Self.encoder().encode(Operation(path: path, value: value, type: type)))
        let input = ControlRemoteInput(requestKey: Self.random(), gatewayId: gateway.gatewayId, bindingRevision: gateway.revision, deviceId: device.deviceId,
                                       modelRevision: device.modelRevision, expiresAt: ISO8601DateFormatter().string(from: .now.addingTimeInterval(20)), operation: operation)
        let record = ControlCommandRecord(reference: ControlCommandReference(origin: origin, principalId: session.principal.principalId, spaceId: space, localSpaceId: gateway.localSpaceId, request: input), attempted: false)
        records.append(record); next.operations = records; try await persist(next); return record
    }
    private func commandContext(_ key: String) async throws -> (ControlMaterial, ControlCommandRecord) {
        let next = try await load()
        guard let material = next.material else { throw ControlError.unauthenticated }
        let session = try await current(material)
        guard let record = next.operations?.first(where: { $0.id == key && $0.reference.principalId == session.principal.principalId && $0.reference.origin == origin }) else { throw ControlError.server("operation_not_found", 404) }
        return (material, record)
    }
    private func saveRecord(_ record: ControlCommandRecord) async throws {
        var next = try await load()
        guard let index = next.operations?.firstIndex(where: { $0.id == record.id && $0.reference == record.reference }) else { throw ControlError.server("operation_not_found", 404) }
        next.operations?[index] = record; try await persist(next)
    }
    private func validate(_ result: ControlRemoteCommand, original: ControlCommandRecord) throws {
        let ref = original.reference, input = ref.request
        guard result.spaceId == ref.spaceId, result.principalId == ref.principalId, result.localSpaceId == ref.localSpaceId,
              result.request == input, Self.matches(result.remoteId, "^remote-[a-f0-9]{64}$"), Self.matches(result.requestDigest, "^[a-f0-9]{64}$") else { throw ControlError.invalidResponse }
        if let old = original.result {
            guard old.remoteId == result.remoteId && old.requestDigest == result.requestDigest,
                  !old.status.terminal || result.status == old.status else { throw ControlError.invalidResponse }
        }
        if result.status == .confirmed {
            let operation = try Self.decoder().decode(JSONValue.self, from: Self.encoder().encode(input.operation))
            guard case .object(let receipt) = result.localResult, receipt["status"] == .string("confirmed"),
                  case .string(let commandId) = receipt["command_id"], Self.matches(commandId, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"),
                  case .string(let digest) = receipt["request_digest"], Self.matches(digest, "^sha256:[a-f0-9]{64}$"),
                  case .object(let request) = receipt["request"], request["space_id"] == .string(ref.localSpaceId),
                  request["idempotency_key"] == .string(result.remoteId), request["device_id"] == .string(input.deviceId),
                  request["model_revision"] == .string(input.modelRevision), request["expires_at"] == .string(input.expiresAt),
                  request["operation"] == operation,
                  case .object(let evidence) = receipt["evidence"], receipt["error"] == .null else { throw ControlError.invalidResponse }
            switch input.operation.type {
            case "property.set":
                guard evidence["type"] == .string("device_result"), case .object(let reported) = evidence["reported"], reported[input.operation.path] == input.operation.value else { throw ControlError.invalidResponse }
            case "action.invoke":
                // 规范化摘要由Go/Rust验证；手机绑定原完整输入并核对证据外壳。
                guard Set(evidence.keys) == Set(["type", "path", "input_digest", "output", "completion", "observed_at"]),
                      evidence["type"] == .string("action_result"), evidence["path"] == .string(input.operation.path),
                      case .string(let inputDigest) = evidence["input_digest"], Self.matches(inputDigest, "^sha256:[a-f0-9]{64}$"),
                      let output = evidence["output"], output != .null,
                      [.string("submitted"), .string("observed")].contains(evidence["completion"]),
                      case .string(let observedText) = evidence["observed_at"], let observed = Self.date(observedText), let expires = Self.date(input.expiresAt),
                      observed >= expires.addingTimeInterval(-32), observed <= Date.now.addingTimeInterval(2) else { throw ControlError.invalidResponse }
            default: throw ControlError.invalidResponse
            }
        }
    }
    private func readCommand(_ record: ControlCommandRecord, material: ControlMaterial, reconcile: Bool = false) async throws -> ControlCommandRecord {
        let base = "/api/console/v1/spaces/" + Self.segment(record.reference.spaceId) + "/remote-commands"
        var result: ControlRemoteCommand = try await http(base + "/by-key/" + record.id, material: material)
        try validate(result, original: record)
        if reconcile && !result.status.terminal {
            var frozen = record; frozen.result = result
            result = try await http(base + "/" + Self.segment(result.remoteId) + "/reconcile", input: Data("{}".utf8), material: material)
            try validate(result, original: frozen)
        }
        var updated = record; updated.attempted = true; updated.result = result; try await saveRecord(updated); return updated
    }
    public func submitCommand(key: String) async throws -> ControlCommandRecord {
        try acquire(); defer { busy = false }
        let (material, original) = try await commandContext(key)
        if original.rejection != nil { return original }
        // 发出过的原键只查询；即使404，也不补发create。
        if original.attempted { return try await readCommand(original, material: material) }
        var record = original; record.attempted = true; try await saveRecord(record)
        let path = "/api/console/v1/spaces/" + Self.segment(record.reference.spaceId) + "/remote-commands"
        do {
            let result: ControlRemoteCommand = try await http(path, input: Self.encoder().encode(record.reference.request), material: material)
            try validate(result, original: record); record.result = result; try await saveRecord(record); return record
        } catch let error as ControlError {
            var rejection: String?
            switch error {
            case .unauthenticated: rejection = "authentication_required"
            case .server(let code, let status) where (400..<500).contains(status) && status != 408 && status != 409: rejection = code
            default: break
            }
            if let rejection { record.rejection = rejection; try await saveRecord(record) }
            throw error
        }
    }
    public func resolveCommand(key: String, reconcile: Bool = false) async throws -> ControlCommandRecord {
        try acquire(); defer { busy = false }
        let (material, record) = try await commandContext(key)
        if record.rejection != nil { return record }
        return try await readCommand(record, material: material, reconcile: reconcile)
    }
    public func commandRecords(space: String? = nil) async throws -> [ControlCommandRecord] {
        try acquire(); defer { busy = false }
        guard let material = try await load().material else { throw ControlError.unauthenticated }
        let session = try await current(material)
        return (try await load().operations ?? []).filter { $0.reference.principalId == session.principal.principalId && (space == nil || $0.reference.spaceId == space) }
    }
    public func forgetCommand(key: String) async throws {
        try acquire(); defer { busy = false }
        let (_, record) = try await commandContext(key)
        guard record.canForget else { throw ControlError.server("operation_not_terminal", 409) }
        var next = try await load(); next.operations?.removeAll { $0.id == key }; try await persist(next)
    }
}
