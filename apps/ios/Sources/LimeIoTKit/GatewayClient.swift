import Foundation

public enum GatewayError: Error, Equatable, Sendable {
    case invalidEndpoint, invalidResponse, unauthenticated, server(String, Int)
    public var definitiveRejection: Bool {
        switch self {
        case .unauthenticated: true
        case .server(let code, let status): (400..<500).contains(status) && status != 408 && !["idempotency_conflict", "request_failed"].contains(code)
        default: false
        }
    }
    public var message: String {
        switch self {
        case .invalidEndpoint: "请输入家庭网关的 HTTPS 地址"
        case .unauthenticated: "会话已过期，请重新连接"
        case .invalidResponse: "网关返回了无法识别的数据"
        case .server(let code, _): [
            "unauthenticated": "所有者凭据无效", "forbidden": "请求未获授权", "device_offline": "设备已离线",
            "rate_limited": "尝试次数过多，请一分钟后重试", "revision_conflict": "规则已更新，请刷新后重试",
            "invalid_threshold": "阈值、单位或滞回不符合设备要求", "invalid_condition": "条件的属性、单位或比较值不符合设备要求", "invalid_simulation": "预演结果未通过核对，请重新预演", "rule_cycle": "联动形成循环，请调整触发条件或执行设备",
            "invalid_schedule": "请检查定时时间、时区和星期", "invalid_schedule_time": "当前时间无法计算定时，请检查网关时钟",
            "inference_not_configured": "网关尚未配置本地模型", "inference_busy": "已有草案正在生成，请稍后再试",
            "inference_unavailable": "无法连接本地模型", "inference_rejected": "本地模型拒绝了请求",
            "inference_unknown": "生成结果未知，请查询原草案", "inference_timeout": "模型响应超时，请查询原草案",
            "invalid_model_output": "模型返回的草案未通过校验", "inference_output_incomplete": "模型返回的草案不完整",
            "inference_output_limit": "模型输出超出限制", "inference_response_too_large": "模型响应超出限制",
            "inference_context_changed": "设备能力已变化，请重新生成草案", "unsupported_intent": "当前设备暂不支持这项联动",
            "unsupported_capability": "草案引用了不支持的设备能力", "draft_expired": "生成请求已过期",
            "draft_not_found": "未找到原草案，请确认网关地址"
        ][code] ?? "请求未完成（\(code)）"
        }
    }
}
public protocol HTTPTransport: Sendable { func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) }
private final class RedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession
    public init() {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForRequest = 12
        session = URLSession(configuration: config, delegate: RedirectPolicy(), delegateQueue: nil)
    }
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw GatewayError.invalidResponse }
        return (data, response)
    }
}
public protocol SessionStore: Sendable {
    func load(origin: String) async throws -> Data?
    func save(origin: String, data: Data?) async throws
}
private struct SavedSession: Codable { let session: Session; let cookie: String }
private struct Failure: Decodable { struct Detail: Decodable { let code: String }; let error: Detail }
public actor GatewayClient {
    public let origin: String
    private let transport: any HTTPTransport
    private let store: (any SessionStore)?
    private var saved: SavedSession?
    private var epoch = 0
    public init(endpoint: String, transport: any HTTPTransport = URLSessionTransport(), store: (any SessionStore)? = nil, allowLoopbackHTTP: Bool = false) throws {
        guard let parts = URLComponents(string: endpoint), let host = parts.host, parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil, parts.path.isEmpty,
              parts.scheme == "https" || (allowLoopbackHTTP && parts.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(host)),
              parts.url?.absoluteString == endpoint else { throw GatewayError.invalidEndpoint }
        origin = endpoint; self.transport = transport; self.store = store
    }
    private static func encoder() -> JSONEncoder { let encoder = JSONEncoder(); encoder.keyEncodingStrategy = .convertToSnakeCase; return encoder }
    private static func decoder() -> JSONDecoder { let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase; return decoder }
    private func call<T: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil, key: String? = nil, authenticated: Bool = true, strictJSON: Bool = false, timeout: TimeInterval = 12, maxJSONBytes: Int = 2_000_000) async throws -> T {
        guard let url = URL(string: origin + path) else { throw GatewayError.invalidEndpoint }
        if authenticated && saved == nil { throw GatewayError.unauthenticated }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        request.timeoutInterval = timeout
        request.httpMethod = method; request.httpBody = body
        request.setValue(origin, forHTTPHeaderField: "Origin")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let saved { request.setValue(saved.cookie, forHTTPHeaderField: "Cookie"); request.setValue(saved.session.csrfToken, forHTTPHeaderField: "X-CSRF-Token") }
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        let current = epoch
        let (data, response) = try await transport.send(request)
        guard epoch == current else { throw CancellationError() }
        guard (200..<300).contains(response.statusCode) else {
            let code = (try? Self.decoder().decode(Failure.self, from: data).error.code) ?? "request_failed"
            if response.statusCode == 401 && authenticated { saved = nil; epoch += 1; try await store?.save(origin: origin, data: nil); throw GatewayError.unauthenticated }
            throw GatewayError.server(code, response.statusCode)
        }
        if path == "/api/v1/auth/session" && method == "POST" {
            guard let cookie = response.value(forHTTPHeaderField: "Set-Cookie")?.components(separatedBy: ";").first,
                  cookie.hasPrefix(origin.hasPrefix("https:") ? "__Host-limeiot_session=" : "limeiot_session=") else { throw GatewayError.invalidResponse }
            let session = try Self.decoder().decode(Session.self, from: data)
            saved = SavedSession(session: session, cookie: cookie)
            try await store?.save(origin: origin, data: Self.encoder().encode(saved))
        }
        if strictJSON {
            guard data.count <= maxJSONBytes, let text = String(data: data, encoding: .utf8), let result = try IntegerJSON.parse(text, maxBytes: maxJSONBytes) as? T else { throw GatewayError.invalidResponse }
            return result
        }
        return try Self.decoder().decode(T.self, from: data.isEmpty ? Data("{}".utf8) : data)
    }
    public func login(token: String) async throws {
        struct Login: Encodable { let token: String }
        epoch += 1; saved = nil
        let _: Session = try await call("/api/v1/auth/session", method: "POST", body: Self.encoder().encode(Login(token: token)), authenticated: false)
    }
    public func restore() async throws {
        guard let data = try await store?.load(origin: origin) else { throw GatewayError.unauthenticated }
        saved = try Self.decoder().decode(SavedSession.self, from: data)
        let _: Session = try await call("/api/v1/auth/session")
    }
    public func logout() async throws {
        struct Empty: Codable, Sendable {}
        let _: Empty = try await call("/api/v1/auth/logout", method: "POST", body: Data("{}".utf8))
        saved = nil; epoch += 1; try await store?.save(origin: origin, data: nil)
    }
    private func base(_ space: String) -> String { "/api/v1/spaces/" + Self.segment(space) }
    private static func segment(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_")))! }
    public func snapshot() async throws -> Snapshot {
        let spaces: Page<Space> = try await call("/api/v1/spaces")
        guard let space = spaces.items.first?.spaceId else { throw GatewayError.invalidResponse }
        let path = base(space)
        async let devices: Page<Device> = call(path + "/devices")
        async let capabilities: Capabilities = call(path + "/capabilities")
        async let commands: Page<Command> = call(path + "/commands")
        async let deployments: Page<Deployment> = call(path + "/rule-deployments")
        async let runs: Page<Run> = call(path + "/runs")
        return try await Snapshot(space: space, devices: devices.items, models: capabilities.models, inference: capabilities.inference, commands: commands, deployments: deployments.items, runs: runs.items)
    }
    public func create(space: String, intent: CommandIntent) async throws -> Command {
        try checkedCommand(await call(base(space) + "/commands", method: "POST", body: Self.encoder().encode(intent.input), key: intent.key), space: space, key: intent.key, intent: intent)
    }
    public func resolve(space: String, key: String) async throws -> Command { try checkedCommand(await call(base(space) + "/commands/by-key/" + Self.segment(key)), space: space, key: key) }
    public func resolve(space: String, intent: CommandIntent) async throws -> Command { try checkedCommand(await call(base(space) + "/commands/by-key/" + Self.segment(intent.key)), space: space, key: intent.key, intent: intent) }
    public func command(space: String, id: String) async throws -> Command { try checkedCommand(await call(base(space) + "/commands/" + Self.segment(id)), space: space, commandId: id) }
    private func checkedCommand(_ value: JSONValue, space: String, key: String? = nil, intent: CommandIntent? = nil, commandId: String? = nil) throws -> Command {
        func text(_ object: [String: JSONValue], _ name: String) throws -> String { guard case .string(let result) = object[name] else { throw GatewayError.invalidResponse }; return result }
        func date(_ text: String) -> Date? { let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; if let value = format.date(from: text) { return value }; format.formatOptions = [.withInternetDateTime]; return format.date(from: text) }
        guard case .object(let receipt) = value, case .object(let request) = receipt["request"], case .object(let operation) = request["operation"] else { throw GatewayError.invalidResponse }
        let status = try text(receipt, "status"), id = try text(receipt, "command_id")
        guard id.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"#, options: .regularExpression) != nil,
              commandId == nil || commandId == id, ["accepted", "dispatched", "confirmed", "unknown", "failed", "expired", "rejected"].contains(status),
              try text(receipt, "request_digest").range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              Set(request.keys) == Set(["space_id", "device_id", "model_revision", "idempotency_key", "expires_at", "operation"]), request["space_id"] == .string(space),
              key == nil || request["idempotency_key"] == .string(key!), Set(operation.keys) == Set(["type", "path", "value"]),
              [.string("property.set"), .string("action.invoke")].contains(operation["type"]), let expires = date(try text(request, "expires_at")) else { throw GatewayError.invalidResponse }
        if let intent {
            let input = try Self.decoder().decode(JSONValue.self, from: Self.encoder().encode(intent.input.operation))
            guard request["device_id"] == .string(intent.input.deviceId), request["model_revision"] == .string(intent.input.modelRevision), request["operation"] == input,
                  date(intent.input.expiresAt) == expires else { throw GatewayError.invalidResponse }
        }
        if status == "confirmed" {
            guard receipt["error"] == .null, case .object(let evidence) = receipt["evidence"] else { throw GatewayError.invalidResponse }
            if operation["type"] == .string("property.set") {
                guard evidence["type"] == .string("device_result"), case .object(let reported) = evidence["reported"], reported[try text(operation, "path")] == operation["value"] else { throw GatewayError.invalidResponse }
            } else {
                guard Set(evidence.keys) == Set(["type", "path", "input_digest", "output", "completion", "observed_at"]), evidence["type"] == .string("action_result"), evidence["path"] == operation["path"],
                      try text(evidence, "input_digest").range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil, let output = evidence["output"], output != .null,
                      [.string("submitted"), .string("observed")].contains(evidence["completion"]), let observed = date(try text(evidence, "observed_at")),
                      observed >= expires.addingTimeInterval(-32), observed <= Date.now.addingTimeInterval(2) else { throw GatewayError.invalidResponse }
            }
        }
        return try Self.decoder().decode(Command.self, from: JSONEncoder().encode(value))
    }
    public func aiCatalog(space: String) async throws -> AiCatalog {
        guard space.range(of: #"^[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil else { throw AiCatalogError() }
        let value: JSONValue = try await call(base(space) + "/ai-catalog", strictJSON: true, maxJSONBytes: 32768)
        return try AiCatalog.parse(IntegerJSON.canonical(value), space: space)
    }
    func otaCall(space: String, suffix: String, method: String = "GET", body: JSONValue? = nil, key: String? = nil) async throws -> JSONValue {
        try await call(base(space) + suffix, method: method, body: body.map { Data(OtaJSON.canonical($0).utf8) }, key: key, strictJSON: true)
    }
    func mediaCall(space: String, suffix: String, method: String = "GET", body: JSONValue? = nil, key: String? = nil) async throws -> JSONValue {
        try await call(base(space) + suffix, method: method, body: body.map { Data(IntegerJSON.canonical($0).utf8) }, key: key, strictJSON: true)
    }
    func observationCall(space: String, suffix: String, method: String = "GET", body: JSONValue? = nil, key: String? = nil, query: Bool = false) async throws -> JSONValue {
        try await call(base(space) + suffix, method: method, body: body.map { Data(IntegerJSON.canonical($0).utf8) }, key: key, strictJSON: true, timeout: query ? 35 : 12)
    }
    public func createDraft(reference: DraftReference, input: DraftInput) async throws -> RuleDraft {
        try await call(base(reference.space) + "/rule-drafts", method: "POST", body: Self.encoder().encode(input), key: reference.key)
    }
    public func resolveDraft(reference: DraftReference) async throws -> RuleDraft {
        try await call(base(reference.space) + "/rule-drafts/by-key/" + Self.segment(reference.key))
    }
    public func simulate(space: String, rule: Rule, eventData: JSONValue) async throws -> Simulation {
        struct Validation: Decodable, Sendable { let valid: Bool; let revision: String; let schedulePreview: JSONValue? }
        let validation: Validation = try await call(base(space) + "/rules:validate", method: "POST", body: Self.encoder().encode(rule))
        struct Input: Encodable { let rule: Rule; let event: JSONValue }
        var sample: [String: JSONValue] = ["device_id": .string(rule.trigger.device), "historical": .bool(false)]
        if rule.trigger.schedule != nil {
            guard case .object(let preview) = validation.schedulePreview, case .string(let at) = preview["scheduled_at"] else { throw GatewayError.invalidResponse }
            sample = ["scheduled_at": .string(at)]
        } else if let property = rule.trigger.property {
            sample["path"] = .string(property.path)
            if case .object(let fields) = eventData { sample["previous"] = fields["previous"]; sample["current"] = fields["current"] }
        } else { sample["path"] = .string(rule.trigger.event!); sample["data"] = eventData }
        let proof: Simulation = try await call(base(space) + "/rules:simulate", method: "POST", body: Self.encoder().encode(Input(rule: rule, event: .object(sample))))
        try RuleProof.verify(proof, rule: rule, valid: validation.valid, validationRevision: validation.revision)
        return proof
    }
    public func deploy(space: String, rule: Rule) async throws -> Deployment { try await call(base(space) + "/rule-deployments", method: "POST", body: Self.encoder().encode(rule)) }
    public func stop(space: String, deployment: Deployment) async throws {
        struct Input: Encodable { let revision: String }
        struct Output: Decodable, Sendable { let stopped: Bool }
        let _: Output = try await call(base(space) + "/rule-deployments/" + Self.segment(deployment.id) + "/stop", method: "POST", body: Self.encoder().encode(Input(revision: deployment.revision)))
    }
}
