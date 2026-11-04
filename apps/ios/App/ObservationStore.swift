import Foundation
import Combine
import LimeIoTKit

struct ObservationReview {
    let binding: ObservationBinding
    let candidate: ObservationCandidate?
    let change: JSONValue
    let expiresAt: Date
}
@MainActor final class ObservationStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var message = ""
    @Published private(set) var coordinator = ""
    @Published private(set) var ieee = ""
    @Published private(set) var endpoint = "1"
    @Published private(set) var profile: ObservationProfile = .environment
    @Published private(set) var device = ""
    @Published private(set) var coordinators: [ObservationCoordinator] = []
    @Published private(set) var bindings: [ObservationBinding] = []
    @Published private(set) var records: [ObservationRecord] = []
    @Published private(set) var review: ObservationReview?
    @Published private(set) var discovery: ObservationDiscovery?
    @Published private(set) var endpoints: ObservationEndpoints?
    let space: String
    let commissioning: ZigbeeStore?
    private let client: ObservationClient
    private let authFailure: (Error) -> Void
    private let now: () -> Date
    private var devices: [Device] = [], context = "", active = true, generation = 0
    private var work: Task<Void, Never>?
    private var selectionEpoch = 0
    init(client: ObservationClient, space: String, authFailure: @escaping (Error) -> Void, now: @escaping () -> Date = Date.init, commissioning: ZigbeeStore? = nil) { self.client = client; self.space = space; self.authFailure = authFailure; self.now = now; self.commissioning = commissioning }
    var operationInProgress: Bool { busy || commissioning?.busy == true }
    var writable: Bool { active && online && ready && !busy }
    var canConfirm: Bool { writable && review.map { $0.expiresAt > now() } == true }
    var staticDevices: [Device] { devices.filter { d in d.observationSource != nil && !bindings.contains { $0.device == d.id && $0.managed } } }
    func updateDevices(_ next: [Device]) {
        let nextContext = next.map { $0.id + ":" + $0.modelRevision + ":" + ($0.observationSource?.adapterId ?? "") + ":" + ($0.observationSource?.revision ?? "") }.sorted().joined(separator: "|")
        devices = next
        if nextContext != context { context = nextContext; invalidate() }
    }
    private func invalidate() { selectionEpoch += 1; review = nil; discovery = nil; endpoints = nil }
    private func selected(_ selection: Int) throws { guard selection == selectionEpoch else { throw CancellationError() } }
    func setCoordinator(_ value: String) { guard active, !busy else { return }; invalidate(); coordinator = value }
    func setIEEE(_ value: String) { guard active, !busy else { return }; invalidate(); if device.isEmpty || device == "zigbee-" + ieee { device = "zigbee-" + value }; ieee = value }
    func setEndpoint(_ value: String) { guard active, !busy else { return }; invalidate(); endpoint = value }
    func setProfile(_ value: ObservationProfile) { guard active, !busy else { return }; invalidate(); profile = value }
    func setDevice(_ value: String) { guard active, !busy else { return }; invalidate(); device = value }
    func cancelReview() { invalidate() }
    private func current(_ epoch: Int) throws { try Task.checkCancellation(); guard active, online, epoch == generation else { throw CancellationError() } }
    private func originals(_ epoch: Int) async throws { let next = try await client.records(space: space); try current(epoch); records = next }
    private func readBindings(_ epoch: Int) async throws {
        let ids = Set(devices.filter { $0.observationSource != nil }.map(\.id) + records.map(\.device)).sorted()
        var next: [ObservationBinding] = []
        for id in ids { let b = try await client.binding(space: space, device: id); try current(epoch); if b.managed { next.append(b) } }
        try current(epoch); bindings = next
    }
    private func task(_ action: @escaping @MainActor (Int) async throws -> Void) {
        guard active, online, !busy else { return }; busy = true; message = ""; let epoch = generation
        work = Task {
            defer { if epoch == generation { busy = false; work = nil } }
            do { try current(epoch); try await action(epoch) }
            catch {
                guard epoch == generation, active, !(error is CancellationError) else { return }
                if let next = try? await client.records(space: space), epoch == generation { records = next }
                guard epoch == generation, active else { return }; ready = false; invalidate()
                message = (error as? ObservationError)?.message ?? (error as? GatewayError)?.message ?? "接入结果待确认，请查询原操作"
                if let error = error as? GatewayError, error == .unauthenticated { authFailure(error) }
            }
        }
    }
    func refresh() {
        invalidate()
        task { epoch in
            self.ready = false; try await self.originals(epoch)
            let page = try await self.client.candidates(space: self.space); try self.current(epoch); self.coordinators = page.coordinators
            if !page.coordinators.contains(where: { $0.id == self.coordinator }) { self.coordinator = page.coordinators.first?.id ?? "" }
            try await self.readBindings(epoch); self.ready = true
        }
    }
    func query() {
        guard writable, let number = Int(endpoint) else { return }
        let selected = coordinator, target = ieee, id = device, capturedContext = context, selectedProfile = profile
        invalidate(); let selection = selectionEpoch
        task { epoch in
            let c = try await self.client.query(space: self.space, coordinator: selected, ieee: target, endpoint: number, profile: selectedProfile); try self.current(epoch)
            let b = try await self.client.binding(space: self.space, device: id); try self.current(epoch)
            try self.selected(selection)
            guard self.context == capturedContext, c.expiresAt > self.now() else { throw ObservationError(code: "observation_review_expired") }
            if !b.managed && self.devices.contains(where: { $0.id == id }) { throw ObservationError(code: "invalid_observation_document") }
            self.review = ObservationReview(binding: b, candidate: c, change: try ObservationJSON.bind(device: id, candidate: c, binding: b), expiresAt: min(c.expiresAt, self.now().addingTimeInterval(60)))
        }
    }
    func discover() {
        guard writable, let selected = coordinators.first(where: { $0.id == coordinator }) else { return }
        invalidate(); let selection = selectionEpoch
        task { epoch in
            let result = try await self.client.discover(space: self.space, coordinator: selected.id); try self.current(epoch); try self.selected(selection)
            guard result.coordinatorIEEE == selected.ieee, result.observedAt <= self.now(), result.expiresAt > self.now() else { throw ObservationError(code: "observation_review_expired") }
            self.discovery = result
        }
    }
    func readEndpoints(_ target: String) {
        guard writable, let found = discovery, found.observedAt <= now(), found.expiresAt > now(), found.items.contains(where: { $0.id == target }),
            let selected = coordinators.first(where: { $0.id == coordinator && $0.ieee == found.coordinatorIEEE }) else { return }
        selectionEpoch += 1; let selection = selectionEpoch; review = nil; endpoints = nil
        if device.isEmpty || device == "zigbee-" + ieee { device = "zigbee-" + target }; ieee = target
        task { epoch in
            let result = try await self.client.endpoints(space: self.space, coordinator: selected.id, ieee: target); try self.current(epoch); try self.selected(selection)
            guard result.coordinatorIEEE == selected.ieee, result.observedAt <= self.now(), result.expiresAt > self.now(), found.expiresAt > self.now() else { throw ObservationError(code: "observation_review_expired") }
            self.endpoints = result
        }
    }
    func queryEndpoint(_ number: Int) {
        guard writable, let result = endpoints, result.ieee == ieee, result.observedAt <= now(), result.expiresAt > now(),
            let selected = result.items.first(where: { $0.id == number && ($0.supportsEnvironment || $0.supportsOnOff) }) else { return }
        endpoint = String(number); profile = selected.supportsEnvironment ? .environment : .onOff; query()
    }
    func rebind(_ binding: ObservationBinding) {
        guard writable, binding.managed, !binding.active, let selected = coordinators.first(where: { $0.ieee == binding.coordinatorIEEE }) else { return }
        coordinator = selected.id; ieee = binding.ieee; endpoint = String(binding.endpoint); profile = binding.profile; device = binding.device; query()
    }
    func reviewRevoke(_ device: String) {
        guard writable else { return }; invalidate(); let capturedContext = context, selection = selectionEpoch
        task { epoch in
            let b = try await self.client.binding(space: self.space, device: device); try self.current(epoch)
            try self.selected(selection)
            guard self.context == capturedContext else { throw ObservationError(code: "observation_review_expired") }
            self.review = ObservationReview(binding: b, candidate: nil, change: try ObservationJSON.revoke(b), expiresAt: self.now().addingTimeInterval(60))
        }
    }
    func confirm() {
        guard canConfirm, let checked = review else { return }; invalidate(); let capturedContext = context, selection = selectionEpoch
        task { epoch in
            let b = try await self.client.binding(space: self.space, device: checked.binding.device); try self.current(epoch)
            try self.selected(selection)
            guard b == checked.binding, self.context == capturedContext, checked.expiresAt > self.now() else { throw ObservationError(code: "observation_review_expired") }
            if let candidate = checked.candidate {
                let page = try await self.client.candidates(space: self.space); try self.current(epoch)
                try self.selected(selection)
                guard page.items.contains(candidate), self.context == capturedContext, checked.expiresAt > self.now() else { throw ObservationError(code: "observation_review_expired") }
            }
            let result = try await self.client.submit(space: self.space, change: checked.change); try self.current(epoch)
            try await self.originals(epoch); try await self.readBindings(epoch); self.message = result.statusText
        }
    }
    func recover(_ key: String) {
        guard records.contains(where: { $0.id == key }) else { return }; invalidate()
        task { epoch in
            let result = try await self.client.resolve(space: self.space, key: key); try self.current(epoch)
            try await self.originals(epoch); try await self.readBindings(epoch); self.message = result.statusText
        }
    }
    func poll() {
        if review.map({ $0.expiresAt <= now() }) == true || discovery.map({ $0.expiresAt <= now() }) == true || endpoints.map({ $0.expiresAt <= now() }) == true {
            invalidate(); message = "读取结果已过期，请重新查询设备"
        }
    }
    func pause() { generation += 1; work?.cancel(); busy = false; ready = false; invalidate(); commissioning?.pause() }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value; commissioning?.setOnline(value) }
    func close() { pause(); active = false; commissioning?.close() }
    func waitForIdle() async { await work?.value }
}
