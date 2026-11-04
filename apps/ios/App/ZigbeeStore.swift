import Foundation
import Combine
import LimeIoTKit

struct ZigbeeReview { let preparation: ZigbeePreparation; let expiresAt: Date }
@MainActor final class ZigbeeStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var coordinator = ""
    @Published private(set) var seconds = "60"
    @Published private(set) var message = ""
    @Published private(set) var coordinators: [ZigbeeCoordinator] = []
    @Published private(set) var records: [ZigbeeRecord] = []
    @Published private(set) var history: [ZigbeeRecord] = []
    @Published private(set) var review: ZigbeeReview?
    let space: String
    private let client: ZigbeeClient
    private let authFailure: (Error) -> Void
    private let now: () -> Date
    private var active = true, generation = 0
    private var work: Task<Void, Never>?
    init(client: ZigbeeClient, space: String, authFailure: @escaping (Error) -> Void, now: @escaping () -> Date = Date.init) { self.client = client; self.space = space; self.authFailure = authFailure; self.now = now }
    var writable: Bool { active && online && ready && !busy }
    var canConfirm: Bool { writable && review.map { $0.expiresAt > now() } == true }
    var entries: [ZigbeeRecord] { history + records.filter { old in !history.contains { $0.id == old.id } } }
    func setCoordinator(_ value: String) { guard active, !busy else { return }; review = nil; coordinator = value }
    func setSeconds(_ value: String) { guard active, !busy else { return }; review = nil; seconds = value }
    func cancelReview() { review = nil }
    private func current(_ epoch: Int) throws { try Task.checkCancellation(); guard active, online, epoch == generation else { throw CancellationError() } }
    private func originals(_ epoch: Int) async throws { let saved = try await client.records(space: space); try current(epoch); records = saved }
    private func read(_ epoch: Int) async throws {
        try await originals(epoch)
        let catalog = try await client.coordinators(space: space), operations = try await client.history(space: space); try current(epoch)
        for old in records { if let result = operations.first(where: { $0.id == old.id })?.result { _ = try ZigbeeJSON.operation(result, expected: old.request, previous: old.result) } }
        coordinators = catalog; history = operations
        if !catalog.contains(where: { $0.id == coordinator }) { coordinator = catalog.first?.id ?? "" }
    }
    private func task(_ action: @escaping @MainActor (Int) async throws -> Void) {
        guard active, online, !busy else { return }; busy = true; message = ""; let epoch = generation
        work = Task {
            defer { if epoch == generation { busy = false; work = nil } }
            do { try current(epoch); try await action(epoch) }
            catch {
                guard epoch == generation, active, !(error is CancellationError) else { return }
                if let saved = try? await client.records(space: space), epoch == generation { records = saved }
                guard epoch == generation, active else { return }; ready = false; review = nil
                message = (error as? ZigbeeError)?.message ?? (error as? GatewayError)?.message ?? "入网结果待确认，请查询原操作"
                if let error = error as? GatewayError, error == .unauthenticated { authFailure(error) }
            }
        }
    }
    func refresh() { review = nil; task { epoch in self.ready = false; try await self.read(epoch); self.ready = true } }
    func prepare(close: Bool = false) {
        guard writable else { return }
        let duration = close ? 0 : Int(seconds) ?? -1
        guard close || (1...120).contains(duration) else { review = nil; message = ZigbeeError("invalid_zigbee_change").message; return }
        review = nil; let selected = coordinator
        task { epoch in
            let result = try await self.client.prepare(space: self.space, coordinator: selected, seconds: duration); try self.current(epoch)
            self.review = ZigbeeReview(preparation: result, expiresAt: self.now().addingTimeInterval(60))
        }
    }
    func confirm() {
        guard canConfirm, let checked = review else { return }; review = nil
        task { epoch in
            let result = try await self.client.submit(space: self.space, preparation: checked.preparation, expiresAt: checked.expiresAt); try self.current(epoch)
            try await self.read(epoch)
            self.message = result.accepted ? (result.seconds == 0 ? "关闭入网协议已受理" : "开放入网协议已受理，请继续发现设备") : "入网结果未知，请查询原操作"
        }
    }
    func recover(_ key: String) {
        guard records.contains(where: { $0.id == key }) || history.contains(where: { $0.id == key }) else { return }; review = nil
        task { epoch in
            _ = try await self.client.resolve(space: self.space, key: key)
            try await self.read(epoch)
            self.message = self.entries.first(where: { $0.id == key })?.accepted == true ? "已查询原操作，协议已受理" : "结果仍未知，请保留原操作记录"
        }
    }
    func poll() { if review.map({ $0.expiresAt <= now() }) == true { review = nil; message = ZigbeeError("zigbee_review_expired").message } }
    func pause() { generation += 1; work?.cancel(); busy = false; ready = false; review = nil }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value }
}
