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
    private func perform(_ action: () async throws -> Void) async {
        guard !busy else { return }
        busy = true; message = ""; defer { busy = false }
        do { try await action() } catch { failure(error) }
    }
    func restore() async {
        await perform {
            let current = try currentClient(); restoredOrigin = endpoint
            pendingAuthorization = try await current.hasPendingAuthorization()
            do { principal = try await current.restoreSession().principal; login = nil; polling = false }
            catch ControlError.unauthenticated {
                principal = nil; clearWorkspace()
                if pendingAuthorization { login = try await current.beginAuthorization(); polling = login?.status == .pending || login?.status == .approved }
                return
            }
            try await loadWorkspace(current)
        }
    }
    func begin() async {
        await perform {
            let current = try currentClient(); restoredOrigin = endpoint
            do { login = try await current.beginAuthorization(); pendingAuthorization = true; polling = login?.status == .pending || login?.status == .approved }
            catch { pendingAuthorization = (try? await current.hasPendingAuthorization()) ?? true; throw error }
        }
    }
    func cancel() async {
        await perform {
            try await currentClient().cancelAuthorization()
            polling = false; pendingAuthorization = false; principal = nil; login = nil; clearWorkspace()
        }
    }
    func resumePolling() { guard login != nil && principal == nil else { return }; polling = true; message = "" }
    func poll() async {
        guard foreground && polling && !busy else { return }
        await perform {
            do {
                let current = try currentClient(), result = try await current.pollAuthorization()
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
    func runForeground() async {
        foregroundEpoch += 1; let epoch = foregroundEpoch; foreground = true
        defer { if epoch == foregroundEpoch { foreground = false; online = false } }
        if !endpoint.isEmpty && restoredOrigin != endpoint { await restore() }
        while !Task.isCancelled {
            if polling { await poll() } else if principal != nil { await refresh() }
            do { try await Task.sleep(for: .seconds(3)) } catch { break }
        }
    }
    func refresh() async {
        guard principal != nil else { return }
        await perform { try await loadWorkspace(currentClient()) }
    }
    func selectSpace(_ id: String) async {
        guard spaces.contains(where: { $0.id == id }) else { return }
        await perform {
            space = id; gateway = nil; devices = []; models = [:]; records = []; hasMore = false; visiblePages = 1; online = false
            try await loadWorkspace(currentClient())
        }
    }
    func loadMore() async {
        guard hasMore else { return }
        await perform { try await loadWorkspace(currentClient(), pageCount: visiblePages + 1) }
    }
    private func loadWorkspace(_ current: ControlClient, pageCount: Int? = nil) async throws {
        let available = try await current.spaces()
        try Task.checkCancellation(); spaces = available
        if !available.contains(where: { $0.id == space }) { space = available.first?.id ?? ""; gateway = nil; devices = []; models = [:]; records = []; hasMore = false; visiblePages = 1 }
        guard !space.isEmpty else { online = true; return }
        records = try await current.commandRecords(space: space)
        let bindings = try await current.gateways(space: space).filter(\.active)
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
        await perform {
            let current = try currentClient()
            let record = try await current.prepareCommand(space: space, gateway: gateway, device: device, path: path, value: value, type: type)
            records.append(record)
            do { _ = try await current.submitCommand(key: record.id) }
            catch {
                if let saved = try? await current.commandRecords(space: space) { records = saved }
                if !(error is ControlError) { message = "操作结果尚未确认，请查询原操作"; online = false; return }
                throw error
            }
            records = try await current.commandRecords(space: space)
        }
    }
    func resolve(_ record: ControlCommandRecord) async {
        await perform {
            let current = try currentClient(), updated = try await current.resolveCommand(key: record.id, reconcile: true)
            if let index = records.firstIndex(where: { $0.id == updated.id }) { records[index] = updated }
        }
    }
    func forget(_ record: ControlCommandRecord) async {
        await perform { try await currentClient().forgetCommand(key: record.id); records.removeAll { $0.id == record.id } }
    }
    func logout() async {
        await perform {
            try await currentClient().logout()
            principal = nil; login = nil; pendingAuthorization = false; polling = false; clearWorkspace()
        }
    }
    func browserFailed() { message = "无法打开浏览器，请检查系统设置后重试" }
}
