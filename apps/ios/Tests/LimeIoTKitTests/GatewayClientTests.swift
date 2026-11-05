import Foundation
import LimeIoTKit

private struct CheckFailure: Error { let name: String }
private func check(_ result: Bool, _ name: String) throws { if !result { throw CheckFailure(name: name) } }

private actor RecordedTransport: HTTPTransport {
    var requests: [URLRequest] = []
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if request.url!.path == "/api/v1/auth/session" {
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Set-Cookie": "__Host-limeiot_session=" + String(repeating: "a", count: 64) + "; Path=/; Secure; HttpOnly"])!
            return (Data("{\"authenticated\":true,\"csrf_token\":\"csrf\",\"expires_at\":\"2030-01-01T00:00:00Z\"}".utf8), response)
        }
        if request.url!.path.contains("/rule-drafts/by-key/") {
            return (Data("{\"draft_id\":\"original-draft\",\"request\":{\"prompt\":\"按下按钮开灯\",\"expires_at\":\"2030-01-01T00:00:00Z\"},\"status\":\"unknown\",\"rule\":null,\"rule_revision\":null,\"error\":\"inference_unknown\"}".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        throw URLError(.timedOut)
    }
}
private func timedOutDraftRecoversOriginalWithoutAnotherSubmission() async throws {
    let transport = RecordedTransport()
    let client = try GatewayClient(endpoint: "https://nas.local:8443", transport: transport)
    try await client.login(token: "one-time-owner-input")
    let reference = DraftReference(space: "space-demo", key: "original-key")
    do { _ = try await client.createDraft(reference: reference, input: DraftInput(prompt: "按下按钮开灯")); throw CheckFailure(name: "expected timeout") } catch is URLError {}
    let recovered = try await client.resolveDraft(reference: reference)
    try check(recovered.status == "unknown" && recovered.rule == nil, "uncertainty preserved")
    let requests = await transport.requests
    try check(requests.count == 3 && requests[2].httpMethod == "GET", "query without replay")
    try check(requests[2].url!.path.hasSuffix("/rule-drafts/by-key/original-key"), "original draft key")
    let request = requests[1]
    try check(request.value(forHTTPHeaderField: "Idempotency-Key") == reference.key, "draft key header")
    let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
    try check(body["space_id"] == nil && body["idempotency_key"] == nil && body["prompt"] as? String == "按下按钮开灯", "draft HTTP input mapping")
}
private func device() throws -> Device {
    let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(Device.self, from: Data("{\"device_id\":\"device-lamp\",\"model_revision\":\"sha256:fixture\",\"ready\":true,\"last_seen\":null,\"reported\":{}}".utf8))
}
private func numericValuesPreserveIntegerContract() throws {
    let value = try JSONDecoder().decode(JSONValue.self, from: Data("42".utf8))
    try check(value == .integer(42), "integer type")
    try check(String(data: try JSONEncoder().encode(value), encoding: .utf8) == "42", "integer encoding")
    try check(JSONDecoder().decode(JSONValue.self, from: Data("true".utf8)) == .bool(true), "boolean type")
}
private func endpointsRequireSecureExactOrigins() throws {
    for endpoint in ["http://nas.local", "https://user@nas.local", "https://nas.local/", "https://nas.local/path", "https://nas.local?token=secret"] {
        do { _ = try GatewayClient(endpoint: endpoint); throw CheckFailure(name: "endpoint accepted") } catch GatewayError.invalidEndpoint {}
    }
    _ = try GatewayClient(endpoint: "https://nas.local:8443")
}
private func sessionHeadersAndUnknownSubmissionDoNotRetry() async throws {
    let transport = RecordedTransport()
    let client = try GatewayClient(endpoint: "https://nas.local:8443", transport: transport)
    try await client.login(token: "one-time-owner-input")
    let intent = CommandIntent(device: try device(), path: "light.brightness", value: .integer(42))
    do { _ = try await client.create(space: "space-demo", intent: intent); throw CheckFailure(name: "expected timeout") } catch is URLError {}
    let requests = await transport.requests
    try check(requests.count == 2, "no command retry")
    let command = requests[1]
    try check(command.value(forHTTPHeaderField: "Idempotency-Key") == intent.key, "original key")
    try check(command.value(forHTTPHeaderField: "X-CSRF-Token") == "csrf", "CSRF")
    try check(command.value(forHTTPHeaderField: "Origin") == "https://nas.local:8443", "origin")
    try check(command.value(forHTTPHeaderField: "Authorization") == nil, "no owner bearer")
    try check(!String(data: command.httpBody!, encoding: .utf8)!.contains("owner"), "credential isolation")
    let body = try JSONSerialization.jsonObject(with: command.httpBody!) as! [String: Any]
    try check(body["space_id"] == nil && body["idempotency_key"] == nil, "HTTP input mapping")
    try check((body["operation"] as? [String: Any])?["value"] as? Int == 42, "integer wire input")
}
private func actualGatewayDeviceResultAndSessionRevocation() async throws {
    let env = ProcessInfo.processInfo.environment
    let client = try GatewayClient(endpoint: env["LIMEIOT_ENDPOINT"]!, allowLoopbackHTTP: true)
    try await client.login(token: env["LIMEIOT_TOKEN"]!)
    let snapshot = try await client.snapshot()
    try check(snapshot.devices.count == 2, "snapshot")
    guard let lamp = snapshot.devices.first(where: { $0.deviceId == "device-lamp" }) else { throw CheckFailure(name: "lamp missing") }
    let intent = CommandIntent(device: lamp, path: "light.brightness", value: .integer(37))
    let accepted = try await client.create(space: snapshot.space, intent: intent)
    var current = accepted
    for _ in 0..<50 {
        if current.status == "confirmed" { break }
        try await Task.sleep(for: .milliseconds(100))
        current = try await client.command(space: snapshot.space, id: accepted.commandId)
    }
    try check(current.status == "confirmed", "device confirmation")
    try check(await client.resolve(space: snapshot.space, key: intent.key).commandId == accepted.commandId, "original command resolution")
    try check(await client.resolve(space: snapshot.space, intent: intent).commandId == accepted.commandId, "complete original command resolution")
    let rule = Rule(id: "swift-rule", source: "device-button", event: "button.pressed", target: "device-lamp", path: "light.power", value: .bool(true), cooldownMs: 0)
    let simulation = try await client.simulate(space: snapshot.space, rule: rule, eventData: .object(["count": .integer(1)]))
    try check(simulation.matched && !simulation.executed, "simulation has no effect")
    let deployment = try await client.deploy(space: snapshot.space, rule: rule)
    try await client.stop(space: snapshot.space, deployment: deployment)
    try check(snapshot.inference?.configured == true, "inference discovered")
    let reference = DraftReference(space: snapshot.space)
    let input = DraftInput(prompt: "按下按钮时把环境灯亮度设为37")
    var draft = try await client.createDraft(reference: reference, input: input)
    for _ in 0..<50 {
        if draft.status != "running" { break }
        try await Task.sleep(for: .milliseconds(100)); draft = try await client.resolveDraft(reference: reference)
    }
    try check(draft.status == "completed", "draft completed")
    try check(await client.createDraft(reference: reference, input: input).id == draft.id, "draft idempotency")
    try check(await client.snapshot().deployments.isEmpty, "no automatic deployment")
    guard let generated = draft.rule, let event = snapshot.eventSample(generated) else { throw CheckFailure(name: "draft rule missing") }
    let proof = try await client.simulate(space: snapshot.space, rule: generated, eventData: event)
    try check(proof.matched && !proof.executed && proof.revision == draft.ruleRevision, "generated rule preview")
    let enabled = try await client.deploy(space: snapshot.space, rule: generated)
    try await client.stop(space: snapshot.space, deployment: enabled)
    try await client.logout()
    do { _ = try await client.snapshot(); throw CheckFailure(name: "revoked session accepted") } catch GatewayError.unauthenticated {}
}

@main enum ClientChecks {
    static func main() async throws {
        if ProcessInfo.processInfo.environment["LIMEIOT_SPACE_SELECTION_CHECK"] == "1" { try await explicitSpaceSelectionChecks(); return }
        if ProcessInfo.processInfo.environment["LIMEIOT_BRIDGE_PHASE"] != nil { try await propertyBridgeLiveChecks(); return }
        if ProcessInfo.processInfo.environment["LIMEIOT_OBSERVATION_CHECK"] == "1" { print("{\"observation_contract_groups\":\(try await observationContractChecks())}"); return }
        if ProcessInfo.processInfo.environment["LIMEIOT_VISION_CHECK"] == "1" { try await visionLiveChecks(); return }
        try numericValuesPreserveIntegerContract()
        try endpointsRequireSecureExactOrigins()
        try await sessionHeadersAndUnknownSubmissionDoNotRetry()
        try await timedOutDraftRecoversOriginalWithoutAnotherSubmission()
        let recoveryChecks = try await commandRecoveryContractChecks()
        print("{\"command_recovery_contract_checks\":\(recoveryChecks)}")
        let otaChecks = try await otaContractChecks()
        let mediaChecks = try await mediaContractChecks()
        print("{\"media_contract_checks\":\(mediaChecks)}")
        let speechChecks = try await speechContractChecks()
        print("{\"speech_contract_checks\":\(speechChecks)}")
        let transcriptionChecks = try await transcriptionContractChecks()
        print("{\"transcription_contract_checks\":\(transcriptionChecks)}")
        let visionChecks = try await visionContractChecks()
        print("{\"vision_contract_checks\":\(visionChecks)}")
        let mediaTargetChecks = try await mediaTargetContractChecks()
        print("{\"media_target_contract_checks\":\(mediaTargetChecks)}")
        let controlChecks = try await controlContractChecks()
        let commandChecks = try await controlCommandContractChecks()
        let actionChecks = try await controlActionContractChecks()
        let ruleChecks = try ruleActionContractChecks()
        let environmentChecks = try environmentContractChecks()
        let thresholdChecks = try thresholdContractChecks()
        let scheduleChecks = try scheduleContractChecks()
        print("{\"schedule_contract_checks\":\(scheduleChecks)}")
        let conditionChecks = try conditionContractChecks()
        print("{\"condition_contract_checks\":\(conditionChecks)}")
        print("{\"threshold_contract_checks\":\(thresholdChecks)}")
        let live = ProcessInfo.processInfo.environment["LIMEIOT_ENDPOINT"] != nil
        let actions = ProcessInfo.processInfo.environment["LIMEIOT_ACTION_CHECK"] == "1"
        let otaLive = ProcessInfo.processInfo.environment["LIMEIOT_OTA_CHECK"] == "1"
        let ruleLive = ProcessInfo.processInfo.environment["LIMEIOT_RULE_ACTION_CHECK"] == "1"
        let environmentLive = ProcessInfo.processInfo.environment["LIMEIOT_ENVIRONMENT_CHECK"] == "1"
        let thresholdLive = ProcessInfo.processInfo.environment["LIMEIOT_THRESHOLD_CHECK"] == "1"
        let conditionLive = ProcessInfo.processInfo.environment["LIMEIOT_CONDITION_CHECK"] == "1"
        let scheduleLive = ProcessInfo.processInfo.environment["LIMEIOT_SCHEDULE_CHECK"] == "1"
        let mediaLive = ProcessInfo.processInfo.environment["LIMEIOT_MEDIA_CHECK"] == "1"
        if mediaLive { try await actualMediaChecks(); print("{\"media_integration\":\"passed\"}") }
        if scheduleLive { try await actualScheduleChecks(); print("{\"schedule_integration\":\"passed\"}") }
        if live && !actions && !otaLive && !ruleLive && !environmentLive && !thresholdLive && !conditionLive && !scheduleLive && !mediaLive { try await actualGatewayDeviceResultAndSessionRevocation() }
        if conditionLive { try await actualConditionChecks(); print("{\"condition_integration\":\"passed\"}") }
        if otaLive { try await actualOtaChecks() }
        if actions { try await actualActionChecks() }
        if ruleLive { try await actualRuleActionChecks() }
        if environmentLive { try await actualEnvironmentChecks() }
        if thresholdLive { try await actualThresholdChecks() }
        print("{\"threshold_integration\":\"\(thresholdLive ? "passed" : "skipped")\"}")
        print("{\"environment_contract_checks\":\(environmentChecks),\"environment_integration\":\"\(environmentLive ? "passed" : "skipped")\"}")
        print("{\"rule_action_contract_checks\":\(ruleChecks),\"rule_action_integration\":\"\(ruleLive ? "passed" : "skipped")\"}")
        let controlLive = ProcessInfo.processInfo.environment["LIMEIOT_NATIVE_CONTROL_CHECK"] == "1"
        if controlLive { try await actualControlClientCheck() }
        print("{\"contract_checks\":4,\"ota_contract_checks\":\(otaChecks),\"control_contract_checks\":\(controlChecks),\"remote_contract_checks\":\(commandChecks),\"action_contract_checks\":\(actionChecks),\"gateway_integration\":\"\(live ? "passed" : "skipped")\",\"control_integration\":\"\(controlLive ? "passed" : "skipped")\"}")
    }
}
