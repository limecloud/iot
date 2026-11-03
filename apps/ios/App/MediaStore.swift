import Foundation
import Combine
import LimeIoTKit

@MainActor final class MediaStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var message = ""
    @Published private(set) var page: MediaPage?
    @Published private(set) var targets: [MediaTarget] = []
    @Published private(set) var records: [MediaRecord] = []
    @Published private(set) var fileName = ""
    @Published private(set) var selectedMedia = ""
    @Published private(set) var selectedTarget = ""
    @Published private(set) var retainSeconds = 3600
    @Published private(set) var grantSeconds = 300
    @Published private(set) var approved = false
    @Published private(set) var deletion: String?
    private var bytes: Data?
    private let client: MediaClient
    let space: String
    private let authFailure: (Error) -> Void
    private var active = true
    private var generation = 0
    private var work: Task<Void, Never>?
    init(client: MediaClient, space: String, authFailure: @escaping (Error) -> Void) { self.client = client; self.space = space; self.authFailure = authFailure }
    var writable: Bool { active && online && ready && !busy && page?.configured == true }
    var canUpload: Bool { writable && bytes != nil }
    var canGrant: Bool { writable && approved && page?.items.contains(where: { $0.id == selectedMedia && $0.available }) == true && targets.contains(where: { $0.deviceId == selectedTarget }) }
    func selectMedia(_ id: String) { guard !busy else { return }; selectedMedia = id; approved = false }
    func selectTarget(_ id: String) { guard !busy else { return }; selectedTarget = id; approved = false }
    func setRetention(_ value: Int) { guard !busy, [600, 3600, 86400].contains(value) else { return }; retainSeconds = value; approved = false }
    func setGrantDuration(_ value: Int) { guard !busy, [30, 300, 600].contains(value) else { return }; grantSeconds = value; approved = false }
    func approve(_ value: Bool) { approved = writable && value }
    func selectFile(name: String, data: Data) {
        guard active, online, !busy else { return }
        do {
            _ = try MediaChanges.upload(bytes: data, retainSeconds: retainSeconds)
            bytes = data; fileName = String(name.filter { $0.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) } }.prefix(128))
            if fileName.isEmpty { fileName = "audio.wav" }; message = ""; approved = false
        } catch { fileFailure(error) }
    }
    func fileFailure(_ error: Error) {
        guard active, online, !busy, !(error is CancellationError) else { return }
        bytes = nil; fileName = ""; approved = false
        message = (error as? MediaError)?.message ?? "无法读取音频，请选择不超过 4 MiB 的 WAV 文件"
    }
    private func current(_ epoch: Int) throws {
        try Task.checkCancellation()
        guard active, online, epoch == generation else { throw CancellationError() }
    }
    private func read(_ epoch: Int) async throws {
        let originals = try await client.records(space: space); try current(epoch); records = originals
        let nextPage = try await client.list(space: space); try current(epoch)
        let nextTargets = try await client.targets(space: space); try current(epoch)
        page = nextPage; targets = nextTargets; ready = true
        if !nextPage.items.contains(where: { $0.id == selectedMedia && $0.available }) { selectedMedia = nextPage.items.first(where: \.available)?.id ?? "" }
        if !nextTargets.contains(where: { $0.deviceId == selectedTarget }) { selectedTarget = nextTargets.first?.deviceId ?? "" }
    }
    private func run(_ action: @escaping @MainActor (Int) async throws -> Void) {
        guard active, online, !busy else { return }
        busy = true; approved = false; deletion = nil; generation += 1; let epoch = generation
        work = Task {
            defer { if epoch == generation { busy = false; work = nil } }
            do { try current(epoch); try await action(epoch) }
            catch {
                guard epoch == generation, active, !(error is CancellationError) else { return }
                if let originals = try? await client.records(space: space), epoch == generation { records = originals }
                guard epoch == generation, active else { return }
                ready = false; approved = false
                message = (error as? MediaError)?.message ?? (error as? GatewayError)?.message ?? "结果未知，请查询音频原操作"
                if let error = error as? GatewayError, error == .unauthenticated { authFailure(error) }
            }
        }
    }
    func refresh() { run { epoch in self.ready = false; try await self.read(epoch); self.message = "" } }
    func useGenerated(_ id: String) async {
        guard active, online, !Task.isCancelled else { return }
        approved = false; deletion = nil
        await waitForIdle()
        guard active, online, !Task.isCancelled else { return }
        run { epoch in
            try await self.read(epoch)
            self.selectedMedia = self.page?.items.contains(where: { $0.id == id && $0.available }) == true ? id : ""
            self.approved = false
        }
        await waitForIdle()
    }
    private func submit(_ change: JSONValue) {
        run { epoch in
            let result = try await self.client.submit(space: self.space, change: change); try self.current(epoch)
            try await self.read(epoch); self.message = result.statusText
        }
    }
    func upload() {
        guard canUpload, let bytes else { return }
        do { let change = try MediaChanges.upload(bytes: bytes, retainSeconds: retainSeconds); self.bytes = nil; fileName = ""; submit(change) }
        catch { fileFailure(error) }
    }
    func grant() {
        guard canGrant, let target = targets.first(where: { $0.deviceId == selectedTarget }) else { return }
        do { submit(try MediaChanges.grant(mediaId: selectedMedia, deviceId: target.deviceId, bindingRevision: target.bindingRevision, validForSeconds: grantSeconds)) }
        catch { fileFailure(error) }
    }
    func revoke(_ id: String) {
        guard writable, page?.grants.contains(where: { $0.id == id }) == true else { return }
        do { submit(try MediaChanges.revoke(grantId: id)) } catch { fileFailure(error) }
    }
    func requestDelete(_ id: String) { guard writable, page?.items.contains(where: { $0.id == id && $0.deletedAt == nil }) == true else { return }; deletion = id; approved = false }
    func cancelDelete() { deletion = nil }
    func confirmDelete() {
        guard writable, let deletion else { return }
        do { submit(try MediaChanges.delete(mediaId: deletion)) } catch { fileFailure(error) }
    }
    func recover(_ key: String) {
        guard records.contains(where: { $0.id == key }) else { return }
        run { epoch in let result = try await self.client.resolve(space: self.space, key: key); try self.current(epoch); try await self.read(epoch); self.message = result.statusText }
    }
    func pause() {
        generation += 1; work?.cancel(); busy = false; ready = false
        approved = false; deletion = nil; bytes = nil; fileName = ""
    }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value }
}
