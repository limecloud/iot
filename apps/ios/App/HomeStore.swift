import Foundation
import Combine
import LimeIoTKit

@MainActor final class HomeStore: ObservableObject {
    @Published var endpoint = UserDefaults.standard.string(forKey: "gateway.origin") ?? ""
    @Published private(set) var connected = false
    @Published private(set) var online = false
    @Published private(set) var busy = false
    @Published private(set) var snapshot: Snapshot?
    @Published private(set) var firmware: FirmwareStore?
    @Published private(set) var media: MediaStore?
    @Published private(set) var pending: [String: CommandIntent] = [:]
    @Published var message = ""
    @Published var draftPrompt = "" { didSet { if oldValue != draftPrompt { draftProof = nil } } }
    @Published private(set) var draftReference: DraftReference?
    @Published private(set) var draft: RuleDraft?
    @Published private(set) var draftBusy = false
    @Published private(set) var draftProof: String?
    @Published private(set) var draftMessage = ""
    private let vault = SecureStore()
    private var client: GatewayClient?
    private var refreshing = false
    private var generation = 0

    func connect(token: String?, restore: Bool = false) async {
        guard !busy, !draftBusy, firmware?.busy != true, media?.busy != true else { return }
        busy = true; message = ""; defer { busy = false }
        do {
            let origin = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
            let next = try GatewayClient(endpoint: origin, store: vault)
            if restore { try await next.restore() } else { try await next.login(token: token ?? "") }
            firmware?.close(); firmware = nil
            media?.close(); media = nil
            client = next; endpoint = origin; generation += 1
            if let data = try await vault.load(origin: origin + "#pending") { pending = try JSONDecoder().decode([String: CommandIntent].self, from: data) } else { pending = [:] }
            draftReference = try await vault.load(origin: origin + "#draft").map { try JSONDecoder().decode(DraftReference.self, from: $0) }
            draft = nil; draftPrompt = ""; draftMessage = ""; draftProof = nil
            UserDefaults.standard.set(origin, forKey: "gateway.origin")
            connected = true
            await refresh()
        } catch GatewayError.unauthenticated where restore { connected = false }
        catch { report(error) }
    }
    func refresh() async {
        guard let client, !refreshing, connected else { return }
        refreshing = true; let current = generation
        defer { refreshing = false }
        do {
            let next = try await client.snapshot()
            guard current == generation else { return }
            snapshot = next; online = true; message = ""
            if firmware == nil { firmware = FirmwareStore(client: OtaClient(gateway: client, store: vault), space: next.space, authFailure: { [weak self] in self?.report($0) }) }
            if media?.space != next.space { media?.close(); media = MediaStore(client: MediaClient(gateway: client, store: vault), space: next.space, authFailure: { [weak self] in self?.report($0) }) }
            media?.setOnline(true)
            if draftReference != nil && (draft == nil || draft?.status == "running") { await recoverDraft() }
        } catch { if current == generation { if !(error is CancellationError) { online = false; media?.setOnline(false) }; report(error) } }
    }
    private func savePending(_ next: [String: CommandIntent]) async throws {
        try await vault.save(origin: endpoint + "#pending", data: JSONEncoder().encode(next))
        pending = next
    }
    func control(_ device: Device, path: String, value: JSONValue, type: String = "property.set") async {
        guard let client, let snapshot, online, !busy, pending[device.id] == nil else { return }
        busy = true; message = ""; defer { busy = false }
        let intent = CommandIntent(device: device, path: path, value: value, type: type)
        var submitted = false
        do {
            var next = pending; next[device.id] = intent; try await savePending(next)
            submitted = true
            _ = try await client.create(space: snapshot.space, intent: intent)
            next = pending; next.removeValue(forKey: device.id); try await savePending(next); await refresh()
        } catch let error as GatewayError {
            if error.definitiveRejection { var next = pending; next.removeValue(forKey: device.id); try? await savePending(next); report(error) }
            else { message = "操作结果尚未确认，请查询原操作" }
        } catch { if submitted { online = false; media?.setOnline(false); message = "操作结果尚未确认，请查询原操作" } else { message = "无法保存本地操作记录，请稍后重试" } }
    }
    func recover(_ device: Device) async {
        guard let client, let snapshot, let intent = pending[device.id], !busy else { return }
        busy = true; defer { busy = false }
        do { _ = try await client.resolve(space: snapshot.space, key: intent.key); var next = pending; next.removeValue(forKey: device.id); try await savePending(next); await refresh() }
        catch { report(error) }
    }
    func simulate(_ rule: Rule, event: JSONValue) async throws -> Simulation {
        guard let client, let snapshot else { throw GatewayError.unauthenticated }
        return try await client.simulate(space: snapshot.space, rule: rule, eventData: event)
    }
    func generateDraft() async {
        guard let client, let snapshot, online, !busy, !draftBusy, snapshot.inference?.configured == true,
              draftReference == nil || (draft != nil && draft?.status != "running") else { return }
        let prompt = draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, prompt.unicodeScalars.count <= 512, prompt.utf8.count <= 2048 else { draftMessage = "请输入不超过 512 字的联动需求"; return }
        draftBusy = true; draftMessage = ""; draftProof = nil
        let current = generation, origin = endpoint
        let reference = DraftReference(space: snapshot.space)
        defer { draftBusy = false }
        do {
            do { try await vault.save(origin: origin + "#draft", data: JSONEncoder().encode(reference)) }
            catch { draftMessage = "无法保存本地生成记录，请稍后重试"; return }
            guard current == generation else { return }
            draftReference = reference; draft = nil; draftPrompt = prompt
            let result = try await client.createDraft(reference: reference, input: DraftInput(prompt: prompt))
            guard current == generation else { return }; draft = result
        } catch {
            guard current == generation else { return }
            if let error = error as? GatewayError, error.definitiveRejection {
                do { try await vault.save(origin: origin + "#draft", data: nil); draftReference = nil } catch {}
            }
            draftFailure(error)
        }
    }
    func recoverDraft() async {
        guard let client, let reference = draftReference, !draftBusy, connected, reference.space == snapshot?.space else { return }
        draftBusy = true; let current = generation; defer { draftBusy = false }
        do {
            let result = try await client.resolveDraft(reference: reference)
            guard current == generation else { return }
            if draft == nil { draftPrompt = result.request.prompt }
            draft = result; draftMessage = ""
        } catch { if current == generation { draftFailure(error) } }
    }
    func newDraft() async {
        guard !draftBusy, draft?.status != "running" else { return }
        draftBusy = true; defer { draftBusy = false }
        do { try await vault.save(origin: endpoint + "#draft", data: nil); draftReference = nil; draft = nil; draftProof = nil; draftMessage = "" }
        catch { draftMessage = "无法更新本地生成记录，请稍后重试" }
    }
    func simulateDraft() async {
        guard let draft, let rule = draft.rule, draft.status == "completed", draftPrompt == draft.request.prompt,
              let sample = snapshot?.eventSample(rule), online, !draftBusy, !busy else { return }
        draftBusy = true; draftProof = nil; draftMessage = ""; let current = generation
        defer { draftBusy = false }
        do {
            let result = try await simulate(rule, event: sample)
            guard current == generation, self.draft?.id == draft.id, draftPrompt == draft.request.prompt else { return }
            if result.matched && result.simulation && !result.executed && result.revision == draft.ruleRevision { draftProof = result.revision; draftMessage = "预演通过，设备尚未执行" }
            else { draftMessage = "预演未通过，请重新生成草案" }
        } catch { if current == generation { draftFailure(error) } }
    }
    func deployDraft() async {
        guard let client, let snapshot, let draft, let rule = draft.rule, let proof = draftProof, proof == draft.ruleRevision,
              draftPrompt == draft.request.prompt, online, !draftBusy, !busy else { return }
        draftBusy = true; draftProof = nil; let current = generation; defer { draftBusy = false }
        do {
            _ = try await client.deploy(space: snapshot.space, rule: rule)
            guard current == generation else { return }; draftMessage = "自动化已启用"; await refresh()
        } catch { if current == generation { draftFailure(error) } }
    }
    private func draftFailure(_ error: Error) {
        if error is CancellationError { return }
        draftMessage = (error as? GatewayError)?.message ?? "生成结果尚未确认，请查询生成结果"
        if let error = error as? GatewayError, error == .unauthenticated { report(error) }
    }
    func deploy(_ rule: Rule) async {
        guard let client, let snapshot, !busy else { return }
        busy = true; defer { busy = false }
        do { _ = try await client.deploy(space: snapshot.space, rule: rule); message = "自动化已启用"; await refresh() } catch { report(error) }
    }
    func stop(_ deployment: Deployment) async {
        guard let client, let snapshot, !busy else { return }
        busy = true; defer { busy = false }
        do { try await client.stop(space: snapshot.space, deployment: deployment); await refresh() } catch { report(error) }
    }
    func logout() async {
        guard let client, !busy, !draftBusy, firmware?.busy != true, media?.busy != true else { return }
        busy = true; defer { busy = false }
        do {
            try await client.logout(); generation += 1; self.client = nil
            firmware?.close(); firmware = nil
            media?.close(); media = nil
            connected = false; online = false; snapshot = nil; pending = [:]
            draftReference = nil; draft = nil; draftPrompt = ""; draftMessage = ""; draftProof = nil
        } catch { report(error) }
    }
    func report(_ error: Error) {
        if error is CancellationError { return }
        if let error = error as? GatewayError {
            message = error.message
            if error == .unauthenticated { generation += 1; firmware?.close(); firmware = nil; media?.close(); media = nil; connected = false; snapshot = nil; pending = [:]; draftReference = nil; draft = nil; draftPrompt = ""; draftProof = nil; draftMessage = "" }
        } else { online = false; media?.setOnline(false); message = "无法连接家庭网关，请检查本地网络" }
    }
}
