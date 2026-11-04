import Foundation
import Combine
import LimeIoTKit

@MainActor final class VoiceTurnStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var message = ""
    @Published private(set) var capabilities: VoiceTurnCapabilities?
    @Published private(set) var record: VoiceTurnRecord?
    @Published private(set) var view: VoiceTurnView?
    @Published private(set) var selectedMedia = ""
    @Published private(set) var voice = ""
    @Published private(set) var confirmation = false
    let space: String
    private let client: VoiceTurnClient, authFailure: (Error) -> Void, now: () -> Date
    private var active = true, advancing = false, generation = 0
    private var work: Task<Void, Never>?
    init(client: VoiceTurnClient, space: String, authFailure: @escaping (Error) -> Void, now: @escaping () -> Date = Date.init) { self.client = client; self.space = space; self.authFailure = authFailure; self.now = now }
    var writable: Bool { active && online && !busy }
    var canStart: Bool { writable && ready && capabilities?.configured == true && !selectedMedia.isEmpty && !voice.isEmpty && (record == nil || ["succeeded", "stopped", "failed"].contains(view?.phase ?? "")) }
    var canContinue: Bool { writable && ready && record != nil && ["ready", "running"].contains(view?.phase ?? "") }
    var visible: VoiceTurnView? { guard let view, !view.record.stopped, ((try? view.record.expiresAt) ?? .distantPast) > now() else { return nil }; return view }
    var statusText: String {
        switch view?.phase { case "ready": "等待继续"; case "running": "正在生成"; case "succeeded": "语音已生成"; case "failed": "生成失败"; case "stopped": "已停止"; case "expired": "回合已到期"; case "unknown": "结果未知"; default: record == nil ? "暂无语音回合" : "请查询原回合" }
    }
    func selectMedia(_ id: String) { guard writable else { return }; selectedMedia = id }
    func selectVoice(_ id: String) { guard writable, capabilities?.speech.voices.contains(id) == true else { return }; voice = id }
    private func current(_ epoch: Int) throws { try Task.checkCancellation(); guard active, online, epoch == generation else { throw CancellationError() } }
    private func accept(_ next: VoiceTurnView, _ epoch: Int, show: Bool = true) throws {
        try current(epoch); record = next.record
        view = show ? next : VoiceTurnView(record: next.record, phase: next.phase, stage: next.stage, transcript: nil, answer: nil, mediaID: nil)
        if !["ready", "running"].contains(next.phase) { advancing = false }
    }
    private func run(_ action: @escaping @MainActor (Int) async throws -> Void) {
        guard writable else { return }; busy = true; message = ""; confirmation = false; let epoch = generation
        work = Task {
            defer { if epoch == generation { busy = false; work = nil } }
            do { try current(epoch); try await action(epoch) }
            catch {
                guard epoch == generation, active, !(error is CancellationError) else { return }
                advancing = false; view = nil; ready = false
                if let saved = try? await client.record(), epoch == generation { record = saved }
                guard epoch == generation, active else { return }
                message = (error as? VoiceTurnError)?.message ?? (error as? GatewayError)?.message ?? "结果未知，请查询原回合"
                if let error = error as? GatewayError, error == .unauthenticated { authFailure(error) }
            }
        }
    }
    func refresh() {
        advancing = false; view = nil
        run { epoch in
            self.ready = false; let capability = try await self.client.capabilities(); try self.current(epoch); self.capabilities = capability
            if !capability.speech.voices.contains(self.voice) { self.voice = capability.speech.voices.first ?? "" }
            let saved = try await self.client.record(); try self.current(epoch); self.record = saved
            if saved != nil { try await self.accept(self.client.resolve(), epoch, show: false) }
            try self.current(epoch); self.ready = true
        }
    }
    func start() {
        guard canStart else { return }
        let id = selectedMedia, voice = voice; advancing = true
        run { epoch in try await self.accept(self.client.start(input: VoiceTurnRequests.input(turnID: UUID().uuidString.lowercased(), mediaID: id, voice: voice)), epoch) }
    }
    func recover() { advancing = false; run { epoch in try await self.accept(self.client.resolve(), epoch); self.ready = true } }
    func continueTurn() { guard canContinue else { return }; advancing = true; run { epoch in try await self.accept(self.client.continueTurn(), epoch) } }
    func poll() {
        guard ready, !confirmation, view?.phase == "running" else { return }
        if advancing { run { epoch in try await self.accept(self.client.continueTurn(), epoch) } }
        else { run { epoch in try await self.accept(self.client.resolve(), epoch, show: false) } }
    }
    func requestStop() { guard writable, record != nil else { return }; confirmation = true }
    func cancelStop() { confirmation = false }
    func confirmStop() {
        guard writable, confirmation else { return }; advancing = false; view = nil
        run { epoch in try await self.accept(self.client.stopTurn(), epoch); self.ready = true }
    }
    func pause() { generation += 1; work?.cancel(); work = nil; busy = false; ready = false; advancing = false; view = nil; selectedMedia = ""; confirmation = false }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value }
}
