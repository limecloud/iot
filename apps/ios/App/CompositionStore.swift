import Foundation
import Combine
import LimeIoTKit

@MainActor final class CompositionStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var blocked = false
    @Published private(set) var message = ""
    @Published private(set) var source: String
    @Published private(set) var custom = false
    @Published private(set) var manifest: CompositionPackage?
    @Published private(set) var bindings: [String: String] = [:]
    @Published private(set) var devices: [Device] = []
    @Published private(set) var record: CompositionRecord?
    @Published private(set) var preview: CompositionPreview?
    private let client: CompositionClient, now: () -> Date, authFailure: (Error) -> Void
    private var instanceID = "composition-" + UUID().uuidString.lowercased()
    private var generation = 0, active = true
    private var work: Task<Void, Never>?, settling: Task<Void, Never>?
    init(client: CompositionClient, authFailure: @escaping (Error) -> Void, now: @escaping () -> Date = Date.init) {
        self.client = client; self.authFailure = authFailure; self.now = now
        source = (try? CompositionPackage.readingCompanionJSON()) ?? ""
        manifest = try? CompositionPackage.parse(source)
    }
    var writable: Bool { active && online && ready && !busy && !blocked }
    var canEdit: Bool { writable && record == nil }
    private var compiled: CompositionCompiled? {
        guard let manifest, manifest.roles.allSatisfy({ role in devices.contains { $0.id == bindings[role] && $0.ready && $0.modelRevision == manifest.modelRevision(role) } }) else { return nil }
        return try? manifest.compile(bindings: bindings, instanceID: instanceID)
    }
    var canPlan: Bool { canEdit && compiled != nil }
    var canDeploy: Bool { canEdit && preview.map { now() >= $0.createdAt && now() < $0.expiresAt } == true }
    private func invalidatePreview() {
        preview = nil; let prior = settling
        settling = Task { await prior?.value; await client.invalidate() }
    }
    func setCustom(_ value: Bool) {
        guard canEdit, value != custom else { return }; custom = value
        source = value ? "" : (try? CompositionPackage.readingCompanionJSON()) ?? ""
        manifest = try? CompositionPackage.parse(source); bindings = [:]; message = ""; invalidatePreview()
    }
    func setSource(_ text: String) {
        guard canEdit, custom else { return }
        guard text.utf8.count <= 32768 else { message = "组合包不能超过 32 KiB"; invalidatePreview(); return }
        guard text != source else { return }; source = text; manifest = try? CompositionPackage.parse(text); bindings = [:]; message = ""; invalidatePreview()
    }
    func bind(_ role: String, device: String) {
        guard canEdit, manifest?.roles.contains(role) == true, bindings[role] != device else { return }
        bindings[role] = device; message = ""; invalidatePreview()
    }
    private func selectedDevices(_ list: [Device]) -> [String] {
        bindings.values.sorted().map { id in list.first { $0.id == id }.map { "\(id):\($0.modelRevision):\($0.ready)" } ?? id + ":missing" }
    }
    func updateDevices(_ list: [Device]) {
        let changed = selectedDevices(devices) != selectedDevices(list); devices = list
        if changed { pause() }
    }
    private enum Result { case loaded(CompositionRecord?), planned(CompositionPreview), deployed(CompositionRecord), resolved(CompositionStatus), prepared }
    private func run(requiresReady: Bool = true, _ action: @escaping @MainActor () async throws -> Result) {
        guard active, online, !busy, !blocked, !requiresReady || ready else { return }
        let epoch = generation, barrier = settling; busy = true; message = ""; preview = nil
        work = Task {
            defer { if epoch == generation { busy = false; work = nil } }
            do {
                await barrier?.value; try Task.checkCancellation(); guard active, online, epoch == generation else { return }
                let result = try await action(); try Task.checkCancellation(); guard active, online, epoch == generation else { return }
                ready = true
                switch result {
                case .loaded(let saved): record = saved
                case .planned(let value): preview = value; message = "预演通过，设备尚未执行"
                case .deployed(let saved): record = saved; message = "组合已启用"
                case .resolved(let status): record = status.record; message = status.message
                case .prepared:
                    record = nil; bindings = [:]; instanceID = "composition-" + UUID().uuidString.lowercased()
                    custom = false; source = (try? CompositionPackage.readingCompanionJSON()) ?? ""; manifest = try? CompositionPackage.parse(source)
                }
            } catch {
                guard active, online, epoch == generation, !(error is CancellationError) else { return }
                message = (error as? CompositionError)?.message ?? (error as? GatewayError)?.message ?? "提交结果待核实，请查询当前部署"
                do { let saved = try await client.record(); try Task.checkCancellation(); guard epoch == generation else { return }; record = saved; ready = true }
                catch { guard epoch == generation else { return }; ready = false; if (error as? CompositionError)?.code == "composition_record_unavailable" { blocked = true; message = "无法核对本地提交记录，已暂停新提交" } }
                if (error as? GatewayError) == .unauthenticated { authFailure(error) }
            }
        }
    }
    func refresh() { run(requiresReady: false) { .loaded(try await self.client.record()) } }
    func plan() { guard canPlan, let compiled else { return }; run { .planned(try await self.client.plan(compiled)) } }
    func deploy() { guard canDeploy else { return }; run { .deployed(try await self.client.deploy()) } }
    func query() { guard record != nil else { return }; run { .resolved(try await self.client.resolve()) } }
    func prepareAnother() { guard record != nil, record?.state != "attempted" else { return }; run { try await self.client.prepareAnother(); return .prepared } }
    func poll() { if let preview, now() < preview.createdAt || now() >= preview.expiresAt { invalidatePreview(); message = "预演已过期，请重新预演" } }
    func pause() {
        generation += 1; let interrupted = work, prior = settling; interrupted?.cancel(); work = nil
        busy = false; ready = false; preview = nil; message = ""
        settling = Task { await prior?.value; await interrupted?.value; await client.invalidate() }
    }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value; await settling?.value }
}
