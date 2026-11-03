import Foundation
import Combine
import LimeIoTKit

@MainActor final class CloudStore: ObservableObject {
    @Published var endpoint: String
    @Published private(set) var principal: ControlPrincipal?
    @Published private(set) var login: NativeLogin?
    @Published private(set) var pendingAuthorization = false
    @Published private(set) var polling = false
    @Published private(set) var busy = false
    @Published private(set) var online = false
    @Published private(set) var foreground = false
    @Published private(set) var message = ""
    @Published private(set) var spaces: [ControlSpace] = []
    @Published private(set) var space = ""
    @Published private(set) var gateway: ControlGateway?
    @Published private(set) var devices: [Device] = []
    @Published private(set) var models: [String: Model] = [:]
    @Published private(set) var records: [ControlCommandRecord] = []
    @Published private(set) var hasMore = false
    private let vault: any SessionStore
    private let preferences: UserDefaults
    private let transport: any HTTPTransport
    private var client: ControlClient?
    private var restoredOrigin: String?
    private var visiblePages = 1
    private var foregroundEpoch = 0
    private var activeAction: Task<Void, Never>?

    init(store: any SessionStore = SecureStore(), preferences: UserDefaults = .standard, transport: any HTTPTransport = URLSessionTransport()) {
        vault = store; self.preferences = preferences; self.transport = transport
        endpoint = preferences.string(forKey: "control.origin") ?? ""
    }
    private func currentClient() throws -> ControlClient {
        let origin = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        if let client, client.origin == origin { return client }
        guard principal == nil && !pendingAuthorization else { throw ControlError.alreadyAuthenticated }
        let next = try ControlClient(endpoint: origin, store: vault, transport: transport)
        client = next; endpoint = origin; preferences.set(origin, forKey: "control.origin")
        return next
    }
    private func clearWorkspace() {
        online = false; spaces = []; space = ""; gateway = nil; devices = []; models = [:]; records = []; hasMore = false; visiblePages = 1
    }
    private func failure(_ error: Error) {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        online = false
        message = (error as? ControlError)?.message ?? "无法连接云服务，请检查网络后重试"
        if error as? ControlError == .unauthenticated { principal = nil; login = nil; polling = false; clearWorkspace() }
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) async {
        guard !busy && !Task.isCancelled else { return }
        busy = true; message = ""
        let operation = Task { @MainActor [self] in
            do { try Task.checkCancellation(); try await action() } catch { failure(error) }
        }
        activeAction = operation
        await withTaskCancellationHandler { await operation.value } onCancel: { operation.cancel() }
        activeAction = nil; busy = false
    }
    func restore() async {
        await perform { [self] in
            let current = try currentClient(); restoredOrigin = endpoint
            let pending = try await current.hasPendingAuthorization(); try Task.checkCancellation(); pendingAuthorization = pending
            do { let session = try await current.restoreSession(); try Task.checkCancellation(); principal = session.principal; login = nil; polling = false }
            catch ControlError.unauthenticated {
                principal = nil; clearWorkspace()
                if pendingAuthorization { let next = try await current.beginAuthorization(); try Task.checkCancellation(); login = next; polling = next.status == .pending || next.status == .approved }
                return
            }
            try await loadWorkspace(current)
        }
    }
    func begin() async {
        await perform { [self] in
            let current = try currentClient(); restoredOrigin = endpoint
            do { let next = try await current.beginAuthorization(); try Task.checkCancellation(); login = next; pendingAuthorization = true; polling = next.status == .pending || next.status == .approved }
            catch {
                try Task.checkCancellation()
                let pending = (try? await current.hasPendingAuthorization()) ?? true
                try Task.checkCancellation(); pendingAuthorization = pending; throw error
            }
        }
    }
    func cancel() async {
        await perform { [self] in
            try await currentClient().cancelAuthorization()
            try Task.checkCancellation()
            polling = false; pendingAuthorization = false; principal = nil; login = nil; clearWorkspace()
        }
    }
    func resumePolling() { guard login != nil && principal == nil else { return }; polling = true; message = "" }
    func poll() async {
        guard foreground && polling && !busy else { return }
        await perform { [self] in
            do {
                let current = try currentClient(), result = try await current.pollAuthorization()
                try Task.checkCancellation()
                switch result.status {
                case .approved:
                    guard let session = result.session else { throw ControlError.invalidResponse }
                    principal = session.principal; login = nil; polling = false
                    try await loadWorkspace(current)
                case .denied: polling = false; message = "登录未获批准，请结束本次登录后重新发起"
                case .cancelled: polling = false; login = nil; pendingAuthorization = false
                case .pending: break
                }
            } catch { if !(error is CancellationError) && (error as? URLError)?.code != .cancelled { polling = false }; throw error }
        }
    }
    func pause() {
        foregroundEpoch &+= 1; foreground = false; online = false
        activeAction?.cancel()
    }
    func runForeground() async {
        pause(); let epoch = foregroundEpoch; foreground = true
        defer { if epoch == foregroundEpoch { pause() } }
        if !endpoint.isEmpty && restoredOrigin != endpoint { await restore() }
        while !Task.isCancelled && epoch == foregroundEpoch && foreground {
            if polling { await poll() } else if principal != nil { await refresh() }
            do { try await Task.sleep(for: .seconds(3)) } catch { break }
        }
    }
    func refresh() async {
        guard principal != nil else { return }
        await perform { [self] in try await loadWorkspace(currentClient()) }
    }
    func selectSpace(_ id: String) async {
        guard spaces.contains(where: { $0.id == id }) else { return }
        await perform { [self] in
            space = id; gateway = nil; devices = []; models = [:]; records = []; hasMore = false; visiblePages = 1; online = false
            try await loadWorkspace(currentClient())
        }
    }
    func loadMore() async {
        guard hasMore else { return }
        await perform { [self] in try await loadWorkspace(currentClient(), pageCount: visiblePages + 1) }
    }
    private func loadWorkspace(_ current: ControlClient, pageCount: Int? = nil) async throws {
        let available = try await current.spaces()
        try Task.checkCancellation(); spaces = available
        if !available.contains(where: { $0.id == space }) { space = available.first?.id ?? ""; gateway = nil; devices = []; models = [:]; records = []; hasMore = false; visiblePages = 1 }
        guard !space.isEmpty else { online = true; return }
        let saved = try await current.commandRecords(space: space); try Task.checkCancellation(); records = saved
        let bindings = try await current.gateways(space: space).filter(\.active)
        try Task.checkCancellation()
        guard bindings.count <= 1 else { throw ControlError.invalidResponse }
        guard let binding = bindings.first else { gateway = nil; devices = []; models = [:]; hasMore = false; online = true; return }
        guard binding.spaceId == space && binding.principalId == principal?.principalId else { throw ControlError.invalidResponse }
        var list: [Device] = [], after: String?, seen: Set<String> = [], count = 0
        repeat {
            let page = try await current.devices(space: space, after: after)
            guard page.bindingRevision == binding.revision else { throw ControlError.invalidResponse }
            list += page.items; after = page.next; count += 1
            if let next = after { guard seen.insert(next).inserted else { throw ControlError.invalidResponse } }
        } while after != nil && count < (pageCount ?? visiblePages)
        guard Set(list.map(\.id)).count == list.count else { throw ControlError.invalidResponse }
        var releases: [String: Model] = [:]
        for revision in Set(list.map(\.modelRevision)) {
            if let cached = models[revision] { releases[revision] = cached }
            else { releases[revision] = try await current.model(space: space, revision: revision) }
        }
        try Task.checkCancellation()
        gateway = binding; devices = list; models = releases; hasMore = after != nil; visiblePages = count; online = true
    }
    func blocked(_ device: Device) -> Bool {
        records.contains { $0.reference.request.deviceId == device.id && $0.rejection == nil && $0.result?.status.terminal != true }
    }
    func control(_ device: Device, path: String, value: JSONValue, type: String = "property.set") async {
        guard foreground && online && !blocked(device), let gateway else { return }
        await perform { [self] in
            let current = try currentClient()
            let record = try await current.prepareCommand(space: space, gateway: gateway, device: device, path: path, value: value, type: type)
            try Task.checkCancellation()
            records.append(record)
            do { _ = try await current.submitCommand(key: record.id) }
            catch {
                try Task.checkCancellation()
                if let saved = try? await current.commandRecords(space: space) { try Task.checkCancellation(); records = saved }
                if !(error is ControlError) { message = "操作结果尚未确认，请查询原操作"; online = false; return }
                throw error
            }
            let saved = try await current.commandRecords(space: space); try Task.checkCancellation(); records = saved
        }
    }
    func resolve(_ record: ControlCommandRecord) async {
        await perform { [self] in
            let current = try currentClient(), updated = try await current.resolveCommand(key: record.id, reconcile: true)
            try Task.checkCancellation()
            if let index = records.firstIndex(where: { $0.id == updated.id }) { records[index] = updated }
        }
    }
    func forget(_ record: ControlCommandRecord) async {
        await perform { [self] in try await currentClient().forgetCommand(key: record.id); try Task.checkCancellation(); records.removeAll { $0.id == record.id } }
    }
    func logout() async {
        await perform { [self] in
            try await currentClient().logout()
            try Task.checkCancellation()
            principal = nil; login = nil; pendingAuthorization = false; polling = false; clearWorkspace()
        }
    }
    func browserFailed() { message = "无法打开浏览器，请检查系统设置后重试" }
}
