import CryptoKit
import Foundation
import LimeIoTKit

private struct ControlCheckFailure: Error { let name: String }
private func expectControl(_ value: Bool, _ name: String) throws { if !value { throw ControlCheckFailure(name: name) } }
private func sha(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
private actor MemoryControlStore: SessionStore {
    var records: [String: Data] = [:]
    var fail = false
    func setFailure(_ value: Bool) { fail = value }
    func load(origin: String) -> Data? { records[origin] }
    func save(origin: String, data: Data?) throws { if fail { throw ControlCheckFailure(name: "storage failure") }; records[origin] = data }
}
private actor ControlFixture: HTTPTransport {
    var requests: [URLRequest] = []
    var loseStart = false
    var unavailable = false
    var revoked = false
    var poison: String?
    var loseCommand = false
    var missingCommand = false
    var rejectCommand = false
    var remotePoison: String?
    var commandInput: [String: Any]?
    var commandStatus = "unknown"
    let origin = "https://control.example"
    let authorization = "na-" + String(repeating: "b", count: 64)
    let token = String(repeating: "c", count: 64)
    let expiry = ISO8601DateFormatter().string(from: .now.addingTimeInterval(300))
    let sessionExpiry = ISO8601DateFormatter().string(from: .now.addingTimeInterval(3500))
    func setLoseStart(_ value: Bool) { loseStart = value }
    func setUnavailable(_ value: Bool) { unavailable = value }
    func setPoison(_ value: String?) { poison = value }
    func setLoseCommand(_ value: Bool) { loseCommand = value }
    func setMissingCommand(_ value: Bool) { missingCommand = value }
    func setRejectCommand(_ value: Bool) { rejectCommand = value }
    func setRemotePoison(_ value: String?) { remotePoison = value }
    private func remoteBody() throws -> [String: Any] {
        guard var input = commandInput else { throw ControlCheckFailure(name: "original command missing") }
        let id = "remote-" + String(repeating: "d", count: 64)
        var body: [String: Any] = ["remote_id": id, "space_id": "space-a", "principal_id": "owner", "local_space_id": "local-space", "request_digest": String(repeating: "a", count: 64), "request": input, "status": commandStatus, "local_result": NSNull()]
        if remotePoison == "principal" { body["principal_id"] = "other" }
        if remotePoison == "request" { input["device_id"] = "other"; body["request"] = input }
        if commandStatus == "confirmed" {
            let operation = input["operation"] as! [String: Any]
            var local: [String: Any] = ["command_id": "cmd-original", "request_digest": "sha256:" + String(repeating: "b", count: 64), "status": "confirmed", "error": NSNull(),
                "request": ["space_id": "local-space", "idempotency_key": id, "device_id": input["device_id"]!, "model_revision": input["model_revision"]!, "expires_at": input["expires_at"]!, "operation": operation],
                "evidence": ["type": "device_result", "reported": [operation["path"] as! String: operation["value"]!]]]
            if operation["type"] as? String == "action.invoke" {
                var evidence: [String: Any] = ["type": "action_result", "path": operation["path"]!, "input_digest": "sha256:" + String(repeating: "b", count: 64), "output": [String: Any](), "completion": remotePoison == "action_observed" ? "observed" : "submitted", "observed_at": ISO8601DateFormatter().string(from: .now)]
                switch remotePoison {
                case "action_type": evidence["type"] = "device_result"
                case "action_path": evidence["path"] = "other.press"
                case "action_digest": evidence["input_digest"] = "invalid"
                case "action_scope": evidence["completion"] = "completed"
                case "action_output": evidence["output"] = NSNull()
                case "action_missing": evidence.removeValue(forKey: "output")
                case "action_time": evidence["observed_at"] = ISO8601DateFormatter().string(from: .now.addingTimeInterval(-60))
                case "action_future": evidence["observed_at"] = ISO8601DateFormatter().string(from: .now.addingTimeInterval(60))
                case "action_extra": evidence["extra"] = true
                case "action_error": local["error"] = "execution_failed"
                default: break
                }
                local["evidence"] = evidence
            }
            if remotePoison == "evidence" { local["evidence"] = NSNull() }
            if remotePoison == "local_request" { local["request"] = NSNull() }
            body["local_result"] = local
        }
        return body
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let path = request.url!.path
        var body: [String: Any] = [:], status = 200
        if path == "/api/native/v1/authorizations" {
            if loseStart { loseStart = false; throw URLError(.networkConnectionLost) }
            body = ["authorization_id": authorization, "user_code": "ABCDEF12", "verification_uri": origin + "/console/?native=" + authorization, "expires_at": expiry, "interval_seconds": 3, "status": "pending"]
            if poison == "redirect" { body["verification_uri"] = "https://other.invalid/console/?native=" + authorization }
        } else if path == "/api/native/v1/authorizations/poll" {
            var material: [String: Any] = ["version": 1, "origin": origin, "audience": "console", "session": token, "principal_id": "owner", "expires_at": sessionExpiry]
            if poison == "origin" { material["origin"] = "https://other.invalid" }
            if poison == "audience" { material["audience"] = "admin" }
            body = ["status": poison == "pending" ? "pending" : "approved", "expires_at": expiry, "material": material]
        } else if path == "/api/native/v1/authorizations/cancel" {
            revoked = true; body = ["status": "cancelled"]
        } else if path == "/api/console/v1/auth/logout" {
            revoked = true; body = ["logged_out": true]
        } else if path == "/api/console/v1/auth/session" {
            if unavailable { status = 503; body = ["error": ["code": "identity_unavailable"]] }
            else if revoked { status = 401; body = ["error": ["code": "identity_rejected"]] }
            else { body = ["audience": "console", "principal": ["principal_id": poison == "principal" ? "other" : "owner", "name": "测试账号"], "csrf_token": sha("limeiot-csrf:console:" + token), "expires_at": sessionExpiry] }
        } else if path.hasSuffix("/remote-commands") && request.httpMethod == "POST" {
            if rejectCommand { status = 403; body = ["error": ["code": "forbidden"]] }
            else {
                commandInput = try JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any]
                if loseCommand { loseCommand = false; throw URLError(.networkConnectionLost) }
                body = try remoteBody()
            }
        } else if path.contains("/remote-commands/by-key/") {
            if missingCommand { status = 404; body = ["error": ["code": "not_found"]] } else { body = try remoteBody() }
        } else if path.hasSuffix("/reconcile") { commandStatus = "confirmed"; body = try remoteBody() }
        else if path == "/api/console/v1/spaces" { body = ["spaces": [["space_id": "space-a", "name": "测试家庭"]]] }
        else { throw ControlCheckFailure(name: "unexpected request") }
        return (try JSONSerialization.data(withJSONObject: body), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Cache-Control": "no-store"])!)
    }
}

func controlContractChecks() async throws -> Int {
    for platform in ["ios", "android", "macos", "windows"] {
        let store = MemoryControlStore(), fixture = ControlFixture()
        let client = try ControlClient(endpoint: "https://control.example", store: store, transport: fixture)
        _ = try await client.beginAuthorization(platform: platform)
        let restored = try ControlClient(endpoint: "https://control.example", store: store, transport: fixture)
        _ = try await restored.beginAuthorization(platform: platform)
        let requests = await fixture.requests
        try expectControl(requests.count == 2, "four platform original proof request count")
        let original = try JSONSerialization.jsonObject(with: requests[0].httpBody!) as! NSDictionary
        let recovered = try JSONSerialization.jsonObject(with: requests[1].httpBody!) as! NSDictionary
        try expectControl(original == recovered, "four platform original proof recovery")
        let input = try JSONSerialization.jsonObject(with: requests[0].httpBody!) as! [String: Any]
        try expectControl(input["platform"] as? String == platform, "explicit authorization platform")
    }
    for endpoint in ["http://control.example", "https://user@control.example", "https://control.example/", "https://control.example/path", "https://control.example?key=x", "http://localhost"] {
        do { _ = try ControlClient(endpoint: endpoint, store: MemoryControlStore(), allowLoopbackHTTP: true); throw ControlCheckFailure(name: "origin accepted") } catch ControlError.invalidEndpoint {}
    }
    let store = MemoryControlStore(), transport = ControlFixture()
    let client = try ControlClient(endpoint: "https://control.example", store: store, transport: transport)
    await store.setFailure(true)
    do { _ = try await client.beginAuthorization(); throw ControlCheckFailure(name: "store failure accepted") } catch is ControlCheckFailure {}
    try expectControl(await transport.requests.isEmpty, "no send before durable proof")
    await store.setFailure(false); await transport.setLoseStart(true)
    do { _ = try await client.beginAuthorization(); throw ControlCheckFailure(name: "expected response loss") } catch is URLError {}
    let recovered = try ControlClient(endpoint: "https://control.example", store: store, transport: transport)
    let login = try await recovered.beginAuthorization()
    let calls = await transport.requests
    try expectControl(calls.count == 2, "original initiation request count")
    let originalInput = try JSONSerialization.jsonObject(with: calls[0].httpBody!) as! NSDictionary
    let restoredInput = try JSONSerialization.jsonObject(with: calls[1].httpBody!) as! NSDictionary
    try expectControl(originalInput == restoredInput, "original initiation restored")
    let persisted = try JSONSerialization.jsonObject(with: await store.records.values.first!) as! [String: Any]
    let proof = (persisted["pending"] as! [String: Any])["proof"] as! [String: Any]
    let verifier = proof["code_verifier"] as! String
    let expected = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    let submitted = try JSONSerialization.jsonObject(with: calls[0].httpBody!) as! [String: Any]
    try expectControl(submitted["code_challenge"] as? String == expected && (submitted["request_key"] as? String)?.count == 64, "S256 and random key")
    try expectControl(!login.description.contains(login.userCode), "redacted presentation")
    let result = try await recovered.pollAuthorization()
    try expectControl(result.status == .approved && result.session?.principal.principalId == "owner", "approved identity")
    let restored = try ControlClient(endpoint: "https://control.example", store: store, transport: transport)
    try expectControl(await restored.restoreSession().principal.principalId == "owner", "durable cloud session")
    try expectControl(await restored.spaces().first?.spaceId == "space-a", "authenticated spaces")
    await transport.setUnavailable(true)
    do { _ = try await restored.restoreSession(); throw ControlCheckFailure(name: "provider failure accepted") } catch ControlError.server("identity_unavailable", 503) {}
    await transport.setUnavailable(false)
    try expectControl(await restored.restoreSession().principal.principalId == "owner", "provider outage retains session")
    // 退出不先调用提供方userinfo，使用当前本站Token派生的CSRF。
    await transport.setUnavailable(true); try await restored.logout(); await transport.setUnavailable(false)
    do { _ = try await restored.restoreSession(); throw ControlCheckFailure(name: "logged out material restored") } catch ControlError.unauthenticated {}
    do { _ = try await recovered.restoreSession(); throw ControlCheckFailure(name: "server revocation accepted") } catch ControlError.unauthenticated {}
    let all = await transport.requests
    for request in all where request.url!.path.hasPrefix("/api/native/") {
        for header in ["Cookie", "Origin", "Authorization"] { try expectControl(request.value(forHTTPHeaderField: header) == nil, "native credential isolation") }
    }
    let logout = all.first(where: { $0.url!.path.hasSuffix("/auth/logout") })!
    try expectControl(logout.url!.path.hasSuffix("/auth/logout") && logout.value(forHTTPHeaderField: "X-CSRF-Token") == sha("limeiot-csrf:console:" + String(repeating: "c", count: 64)), "logout CSRF")
    try expectControl(await store.records.keys.allSatisfy { $0.hasPrefix("limeiot.control:v1:") }, "NAS storage isolation")
    for poison in ["redirect", "origin", "audience", "principal", "pending"] {
        let poisoned = ControlFixture(), secure = MemoryControlStore()
        let next = try ControlClient(endpoint: "https://control.example", store: secure, transport: poisoned)
        await poisoned.setPoison(poison)
        do {
            _ = try await next.beginAuthorization()
            _ = try await next.pollAuthorization()
            throw ControlCheckFailure(name: "poisoned response accepted")
        } catch ControlError.invalidResponse {}
        let requests = await poisoned.requests
        if ["origin", "audience", "pending"].contains(poison) { try expectControl(requests.allSatisfy { $0.value(forHTTPHeaderField: "Cookie") == nil }, "invalid material never used") }
    }
    let cancelled = try ControlClient(endpoint: "https://control.example", store: MemoryControlStore(), transport: ControlFixture())
    _ = try await cancelled.beginAuthorization(); _ = try await cancelled.pollAuthorization(); try await cancelled.cancelAuthorization()
    do { _ = try await cancelled.restoreSession(); throw ControlCheckFailure(name: "cancel left session") } catch ControlError.unauthenticated {}
    return 4
}

func controlActionContractChecks() async throws -> Int {
    let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
    let gateway = try decoder.decode(ControlGateway.self, from: Data("{\"gateway_id\":\"gw-a\",\"space_id\":\"space-a\",\"local_space_id\":\"local-space\",\"principal_id\":\"owner\",\"scopes\":[\"commands.write\"],\"revision\":\"revision-a\",\"active\":true}".utf8))
    let device = try decoder.decode(Device.self, from: Data("{\"device_id\":\"device-tv\",\"model_revision\":\"sha256:fixture\",\"ready\":true,\"reported\":{}}".utf8))
    for completion in ["submitted", "observed"] {
        let store = MemoryControlStore(), transport = ControlFixture()
        let client = try ControlClient(endpoint: "https://control.example", store: store, transport: transport)
        _ = try await client.beginAuthorization(); _ = try await client.pollAuthorization()
        await store.setFailure(true)
        do { _ = try await client.prepareCommand(space: "space-a", gateway: gateway, device: device, path: "remote.press", value: .object(["key": .string("home")]), type: "action.invoke"); throw URLError(.unknown) } catch is ControlCheckFailure {}
        await store.setFailure(false)
        let record = try await client.prepareCommand(space: "space-a", gateway: gateway, device: device, path: "remote.press", value: .object(["key": .string("home")]), type: "action.invoke")
        await transport.setLoseCommand(true)
        do { _ = try await client.submitCommand(key: record.id); throw ControlCheckFailure(name: "lost action response expected") } catch is URLError {}
        let restored = try ControlClient(endpoint: "https://control.example", store: store, transport: transport)
        _ = try await restored.submitCommand(key: record.id)
        if completion == "observed" { await transport.setRemotePoison("action_observed") }
        let result = try await restored.resolveCommand(key: record.id, reconcile: true)
        guard case .object(let receipt) = result.result?.localResult else { throw ControlCheckFailure(name: "action evidence missing") }
        try expectControl(Command.actionStatus(receipt["evidence"]) == (completion == "submitted" ? "输入已提交" : "效果已观测"), "action scope presentation")
        try expectControl(record.reference.request.operation.summary == "遥控：主页", "typed action summary")
        try expectControl(await transport.requests.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/remote-commands") }.count == 1, "action create cannot replay")
    }
    for poison in ["request", "local_request", "evidence", "action_type", "action_path", "action_digest", "action_scope", "action_output", "action_missing", "action_time", "action_future", "action_extra", "action_error"] {
        let transport = ControlFixture(), store = MemoryControlStore()
        let client = try ControlClient(endpoint: "https://control.example", store: store, transport: transport)
        _ = try await client.beginAuthorization(); _ = try await client.pollAuthorization()
        let record = try await client.prepareCommand(space: "space-a", gateway: gateway, device: device, path: "remote.press", value: .object(["key": .string("home")]), type: "action.invoke")
        _ = try await client.submitCommand(key: record.id); await transport.setRemotePoison(poison)
        do { _ = try await client.resolveCommand(key: record.id, reconcile: true); throw ControlCheckFailure(name: "bad action evidence accepted: " + poison) } catch ControlError.invalidResponse {}
        try expectControl(await client.commandRecords(space: "space-a").first?.result?.status == .unknown, "bad action evidence cannot confirm")
    }
    let transport = ControlFixture(), client = try ControlClient(endpoint: "https://control.example", store: MemoryControlStore(), transport: transport)
    _ = try await client.beginAuthorization(); _ = try await client.pollAuthorization()
    let longest = String(repeating: "a", count: 64) + "." + String(repeating: "b", count: 64)
    _ = try await client.prepareCommand(space: "space-a", gateway: gateway, device: device, path: longest, value: .object([:]), type: "action.invoke")
    for path in [String(repeating: "a", count: 65) + ".b", "a." + String(repeating: "b", count: 65), "remote", "Remote.press", "remote.press.more", "remote.press\n"] {
        do { _ = try await client.prepareCommand(space: "space-a", gateway: gateway, device: device, path: path, value: .object([:]), type: "action.invoke"); throw ControlCheckFailure(name: "bad path accepted") } catch ControlError.invalidResponse {}
    }
    do { _ = try await client.prepareCommand(space: "space-a", gateway: gateway, device: device, path: "remote.press", value: .object([:]), type: "shell"); throw ControlCheckFailure(name: "bad type accepted") } catch ControlError.invalidResponse {}
    try expectControl(await transport.requests.allSatisfy { !$0.url!.path.hasSuffix("/remote-commands") }, "validation does not send")
    return 3
}

func controlCommandContractChecks() async throws -> Int {
    let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
    let gateway = try decoder.decode(ControlGateway.self, from: Data("{\"gateway_id\":\"gw-a\",\"space_id\":\"space-a\",\"local_space_id\":\"local-space\",\"principal_id\":\"owner\",\"scopes\":[\"commands.write\"],\"revision\":\"revision-a\",\"active\":true}".utf8))
    let device = try decoder.decode(Device.self, from: Data("{\"device_id\":\"device-lamp\",\"model_revision\":\"sha256:fixture\",\"ready\":true,\"reported\":{},\"last_seen\":null}".utf8))
    let store = MemoryControlStore(), fixture = ControlFixture()
    let client = try ControlClient(endpoint: "https://control.example", store: store, transport: fixture)
    _ = try await client.beginAuthorization(); _ = try await client.pollAuthorization()
    await store.setFailure(true)
    do { _ = try await client.prepareCommand(space: "space-a", gateway: gateway, device: device, path: "light.brightness", value: .integer(37)); throw URLError(.unknown) } catch is ControlCheckFailure {}
    await store.setFailure(false)
    try expectControl(await client.commandRecords(space: "space-a").isEmpty, "failed prepare did not create an operation")
    let record = try await client.prepareCommand(space: "space-a", gateway: gateway, device: device, path: "light.brightness", value: .integer(37))
    let secondGateway = try decoder.decode(ControlGateway.self, from: Data("{\"gateway_id\":\"gw-b\",\"space_id\":\"space-b\",\"local_space_id\":\"local-b\",\"principal_id\":\"owner\",\"scopes\":[\"commands.write\"],\"revision\":\"revision-b\",\"active\":true}".utf8))
    let second = try await client.prepareCommand(space: "space-b", gateway: secondGateway, device: device, path: "light.brightness", value: .integer(38))
    try expectControl(await client.commandRecords().count == 2, "all original spaces available without selected target")
    try expectControl(await client.commandRecords(space: "space-a").count == 1, "explicit space still filters records")
    try await client.forgetCommand(key: second.id)
    await store.setFailure(true)
    do { _ = try await client.submitCommand(key: record.id); throw URLError(.unknown) } catch is ControlCheckFailure {}
    let before = await fixture.requests
    try expectControl(before.allSatisfy { !$0.url!.path.hasSuffix("/remote-commands") }, "attempt must be durable before submit")
    await store.setFailure(false); await fixture.setLoseCommand(true)
    do { _ = try await client.submitCommand(key: record.id); throw ControlCheckFailure(name: "lost command response expected") } catch is URLError {}
    let restored = try ControlClient(endpoint: "https://control.example", store: store, transport: fixture)
    await fixture.setMissingCommand(true)
    do { _ = try await restored.submitCommand(key: record.id); throw ControlCheckFailure(name: "missing original expected") } catch ControlError.server("not_found", 404) {}
    do { try await restored.forgetCommand(key: record.id); throw ControlCheckFailure(name: "unknown record removed") } catch ControlError.server("operation_not_terminal", 409) {}
    await fixture.setMissingCommand(false)
    let unknown = try await restored.submitCommand(key: record.id)
    try expectControl(unknown.result?.status == .unknown && unknown.attempted, "unknown result preserved")
    let result = try await restored.resolveCommand(key: record.id, reconcile: true)
    try expectControl(result.result?.status == .confirmed, "confirmed original device evidence")
    let calls = await fixture.requests
    try expectControl(calls.filter { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/remote-commands") }.count == 1, "create only once")
    try expectControl(calls.contains { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/reconcile") }, "explicit reconciliation")
    try await restored.logout()
    let again = try ControlClient(endpoint: "https://control.example", store: store, transport: fixture)
    do { _ = try await again.commandRecords(space: "space-a"); throw ControlCheckFailure(name: "logged out operations exposed") } catch ControlError.unauthenticated {}
    let stored = try JSONSerialization.jsonObject(with: await store.records.values.first!) as! [String: Any]
    try expectControl((stored["operations"] as? [Any])?.count == 1 && stored["material"] == nil, "operations retained separately from session")
    for poison in ["principal", "request", "evidence", "local_request"] {
        let transport = ControlFixture(), secure = MemoryControlStore()
        let next = try ControlClient(endpoint: "https://control.example", store: secure, transport: transport)
        _ = try await next.beginAuthorization(); _ = try await next.pollAuthorization()
        let original = try await next.prepareCommand(space: "space-a", gateway: gateway, device: device, path: "light.brightness", value: .integer(37))
        _ = try await next.submitCommand(key: original.id)
        await transport.setRemotePoison(poison)
        do { _ = try await next.resolveCommand(key: original.id, reconcile: true); throw ControlCheckFailure(name: "invalid remote response accepted") } catch ControlError.invalidResponse {}
        try expectControl(await next.commandRecords(space: "space-a").first?.result?.status == .unknown, "invalid receipt did not confirm")
    }
    let rejectedFixture = ControlFixture(), rejectedStore = MemoryControlStore()
    let rejected = try ControlClient(endpoint: "https://control.example", store: rejectedStore, transport: rejectedFixture)
    _ = try await rejected.beginAuthorization(); _ = try await rejected.pollAuthorization()
    let denied = try await rejected.prepareCommand(space: "space-a", gateway: gateway, device: device, path: "light.power", value: .bool(true))
    await rejectedFixture.setRejectCommand(true)
    do { _ = try await rejected.submitCommand(key: denied.id); throw ControlCheckFailure(name: "expected rejection") } catch ControlError.server("forbidden", 403) {}
    try expectControl(await rejected.submitCommand(key: denied.id).rejection == "forbidden", "definitive rejection retained")
    try await rejected.forgetCommand(key: denied.id)
    try expectControl(await rejected.commandRecords(space: "space-a").isEmpty, "terminal cleanup allowed")
    let preparedFixture = ControlFixture(), preparedStore = MemoryControlStore()
    let prepared = try ControlClient(endpoint: "https://control.example", store: preparedStore, transport: preparedFixture)
    _ = try await prepared.beginAuthorization(); _ = try await prepared.pollAuthorization()
    let unsent = try await prepared.prepareCommand(space: "space-a", gateway: gateway, device: device, path: "light.power", value: .bool(true))
    try expectControl(unsent.isPrepared && unsent.canForget, "prepared record is explicitly discardable")
    let reopened = try ControlClient(endpoint: "https://control.example", store: preparedStore, transport: preparedFixture)
    try await reopened.forgetCommand(key: unsent.id)
    try expectControl(await reopened.commandRecords(space: "space-a").isEmpty, "unsent record discarded after client recreation")
    let noCreate = await preparedFixture.requests.allSatisfy { !$0.url!.path.hasSuffix("/remote-commands") }
    try expectControl(noCreate, "discarding unsent record does not submit")
    return 4
}

private actor FileControlStore: SessionStore {
    let directory: URL
    init(_ directory: URL) { self.directory = directory }
    func load(origin: String) throws -> Data? {
        let path = directory.appendingPathComponent(sha(origin) + ".json")
        return FileManager.default.fileExists(atPath: path.path) ? try Data(contentsOf: path) : nil
    }
    func save(origin: String, data: Data?) throws {
        let path = directory.appendingPathComponent(sha(origin) + ".json")
        try (data ?? Data()).write(to: path, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        let handle = try FileHandle(forWritingTo: path); defer { try? handle.close() }; try handle.synchronize()
    }
}

func actualControlClientCheck() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let origin = env["LIMEIOT_TEST_CONTROL_ORIGIN"], let path = env["LIMEIOT_NATIVE_CHECK_DIRECTORY"] else { throw ControlCheckFailure(name: "native fixture missing") }
    let directory = URL(fileURLWithPath: path), store = FileControlStore(URL(fileURLWithPath: path))
    var transport: any HTTPTransport = URLSessionTransport()
    if let ca = env["LIMEIOT_TEST_CONTROL_CA_FILE"] {
        let untrusted = try ControlClient(endpoint: origin, store: store)
        do { _ = try await untrusted.beginAuthorization(); throw ControlCheckFailure(name: "untrusted CA accepted") } catch is URLError {}
        transport = try ControlTLSTransport(caFile: ca, origin: origin)
    }
    let client = try ControlClient(endpoint: origin, store: store, transport: transport, allowLoopbackHTTP: true)
    let login = try await client.beginAuthorization()
    let encoder = JSONEncoder(); encoder.keyEncodingStrategy = .convertToSnakeCase
    let request = directory.appendingPathComponent("login.json")
    try encoder.encode(login).write(to: request, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: request.path)
    var result = try await client.pollAuthorization()
    for _ in 0..<30 {
        if result.status != .pending { break }
        try await Task.sleep(for: .seconds(3)); result = try await client.pollAuthorization()
    }
    try expectControl(result.status == .approved && result.session != nil, "real browser approval")
    let restored = try ControlClient(endpoint: origin, store: store, transport: transport, allowLoopbackHTTP: true)
    try expectControl(await restored.restoreSession().principal.principalId == result.session?.principal.principalId, "real stored identity")
    let spaces = try await restored.spaces()
    try expectControl(!spaces.isEmpty, "real account spaces")
    guard let space = env["LIMEIOT_NATIVE_CHECK_SPACE"], spaces.contains(where: { $0.spaceId == space }),
          let gateway = try await restored.gateways(space: space).first(where: { $0.active }) else { throw ControlCheckFailure(name: "paired test space missing") }
    let page = try await restored.devices(space: space)
    guard let lamp = page.items.first(where: { $0.deviceId == "device-lamp" }) else { throw ControlCheckFailure(name: "remote lamp missing") }
    try expectControl(page.bindingRevision == gateway.revision, "current binding revision")
    let action = env["LIMEIOT_NATIVE_CHECK_ACTION"] == "1"
    try expectControl(await restored.model(space: space, revision: lamp.modelRevision).services.contains(where: { $0.id == (action ? "remote" : "light") }), "remote model")
    let record = try await restored.prepareCommand(space: space, gateway: gateway, device: lamp, path: action ? "remote.press" : "light.brightness", value: action ? .object(["key": .string("home")]) : .integer(37), type: action ? "action.invoke" : "property.set")
    try encoder.encode(record).write(to: directory.appendingPathComponent("operation.json"), options: .atomic)
    func wait(_ marker: String) async throws {
        for _ in 0..<300 {
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent(marker).path) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ControlCheckFailure(name: "fixture marker timeout")
    }
    try await wait("send")
    do { _ = try await restored.submitCommand(key: record.id); throw ControlCheckFailure(name: "expected lost remote response") } catch is URLError {}
    try Data("unknown".utf8).write(to: directory.appendingPathComponent("unknown"))
    try await wait("recover")
    let recovered = try ControlClient(endpoint: origin, store: store, transport: transport, allowLoopbackHTTP: true)
    var outcome = try await recovered.submitCommand(key: record.id)
    for _ in 0..<20 {
        if outcome.result?.status.terminal == true { break }
        try await Task.sleep(for: .milliseconds(200)); outcome = try await recovered.resolveCommand(key: record.id, reconcile: true)
    }
    try expectControl(outcome.result?.status == .confirmed && outcome.reference == record.reference, "real original command confirmation")
    if action {
        guard case .object(let receipt) = outcome.result?.localResult else { throw ControlCheckFailure(name: "real action evidence missing") }
        try expectControl(Command.actionStatus(receipt["evidence"]) == "输入已提交", "real action completion scope")
    }
    try await recovered.logout()
    let after = try ControlClient(endpoint: origin, store: store, transport: transport, allowLoopbackHTTP: true)
    do { _ = try await after.commandRecords(space: space); throw ControlCheckFailure(name: "logged out real operations exposed") } catch ControlError.unauthenticated {}
    do { _ = try await client.restoreSession(); throw ControlCheckFailure(name: "real revoked child accepted") } catch ControlError.unauthenticated {}
}
