import Foundation
import Combine
import LimeIoTKit

@MainActor final class CompanionStore: ObservableObject {
    static let defaultInstructions = "你是积木小狗豆豆，喜欢和用户讨论积木、故事与日常发现。用温和、简短的中文回答，每次不超过300字。不能调用工具或声称控制了设备。遇到不确定的问题说明不确定；涉及危险活动时建议请家长帮助。"
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var online = true
    @Published private(set) var message = ""
    @Published private(set) var capabilities: VoiceTurnCapabilities?
    @Published private(set) var record: CompanionRecord?
    @Published private(set) var view: CompanionView?
    @Published private(set) var selectedMedia = ""
    @Published private(set) var voice = ""
    @Published private(set) var instructions = defaultInstructions
    @Published private(set) var confirmation = false
    let space: String
    private let client: CompanionClient, authFailure: (Error) -> Void, now: () -> Date
    private var active = true, advancing = false, generation = 0
    private var work: Task<Void, Never>?, forgetting: Task<Void, Never>?
    init(client: CompanionClient, space: String, authFailure: @escaping (Error) -> Void, now: @escaping () -> Date = Date.init) { self.client = client; self.space = space; self.authFailure = authFailure; self.now = now }
    var writable: Bool { active && online && !busy }
    var canStart: Bool { writable && ready && capabilities?.configured == true && !voice.isEmpty && (record == nil || view?.stopSettled == true) }
    var canEdit: Bool { writable && (record == nil || view?.stopSettled == true) }
    var live: Bool { record?.stopped == false && ((try? record?.expiresAt) ?? .distantPast) > now() }
    var canReply: Bool { writable && ready && live && view?.canReply == true && !selectedMedia.isEmpty }
    var canContinue: Bool { writable && ready && live && view?.historyAvailable == true && ["ready", "running", "paused"].contains(view?.phase ?? "") }
    var visible: VoiceTurnView? { live ? view?.turn : nil }
    var statusText: String {
        guard let record else { return "暂无陪伴会话" }
        if !record.stopped && !live { return "会话已到期" }
        switch view?.phase { case "ready": return record.turnCount == 0 ? "会话已开始" : "等待继续"; case "running": return "正在生成"; case "succeeded": return "回答已生成，剩余 \(view?.turnsRemaining ?? 0) 轮"; case "stopped": return view?.stopSettled == true ? "会话已停止" : "正在核实停止结果"; case "unknown": return "结果未知"; case "prepared": return "原回合准备未完成，请停止会话"; case "failed": return "生成失败"; default: return "请查询原会话" }
    }
    func selectMedia(_ id: String) { if writable { selectedMedia = id } }
    func selectVoice(_ id: String) { if canEdit, capabilities?.speech.voices.contains(id) == true { voice = id } }
    func setInstructions(_ value: String) { if canEdit { instructions = value } }
    private func current(_ epoch: Int) throws { try Task.checkCancellation(); guard active, online, epoch == generation else { throw CancellationError() } }
    private func accept(_ next: CompanionView, _ epoch: Int, show: Bool = true) throws {
        try current(epoch); record = next.record
        view = show ? next : next.redactingOutput()
        ready = true; if !["ready", "running"].contains(next.phase) { advancing = false }
    }
    private func run(_ action: @escaping @MainActor (Int) async throws -> Void) {
        guard writable else { return }; busy = true; message = ""; confirmation = false; let epoch = generation, barrier = forgetting
        work = Task {
            defer { if epoch == generation { busy = false; work = nil } }
            do { await barrier?.value; try current(epoch); try await action(epoch) }
            catch {
                guard epoch == generation, active, !(error is CancellationError) else { return }
                advancing = false; view = nil; ready = false
                if let saved = try? await client.record(), epoch == generation { record = saved }
                guard epoch == generation, active else { return }
                message = (error as? CompanionError)?.message ?? (error as? VoiceTurnError)?.message ?? (error as? GatewayError)?.message ?? "结果未知，请查询原会话"
                if let error = error as? GatewayError, error == .unauthenticated { authFailure(error) }
            }
        }
    }
    func refresh() {
        guard writable else { return }; advancing = false; view = nil
        run { epoch in
            self.ready = false; let capability = try await self.client.capabilities(); try self.current(epoch); self.capabilities = capability
            if !capability.speech.voices.contains(self.voice) { self.voice = capability.speech.voices.first ?? "" }
            let saved = try await self.client.record(); try self.current(epoch); self.record = saved
            if saved != nil { try await self.accept(self.client.resolve(), epoch, show: false) }
            try self.current(epoch); self.ready = true
        }
    }
    func start() {
        guard canStart else { return }; let voice = voice, instructions = instructions
        run { epoch in
            let policy = try CompanionPolicy.parse(OtaJSON.canonical(.object(["schema_version": .integer(1), "policy_id": .string("native-companion"), "version": .string("1.0.0"), "name": .string("陪伴角色"), "instructions": .string(instructions), "language": .string("zh"), "voice": .string(voice), "max_turns": .integer(4), "max_seconds": .integer(600)])))
            try await self.accept(self.client.start(sessionID: UUID().uuidString.lowercased(), policy: policy), epoch)
        }
    }
    func reply() { guard canReply else { return }; advancing = true; let media = selectedMedia; run { epoch in try await self.accept(self.client.reply(mediaID: media), epoch) } }
    func recover() { advancing = false; run { epoch in try await self.accept(self.client.resolve(), epoch) } }
    func continueSession() { guard canContinue else { return }; advancing = true; run { epoch in try await self.accept(self.client.continueSession(), epoch) } }
    func poll() {
        guard ready, !confirmation, view?.phase == "running" else { return }
        if advancing { run { epoch in try await self.accept(self.client.continueSession(), epoch) } }
        else { run { epoch in try await self.accept(self.client.resolve(), epoch, show: false) } }
    }
    func requestStop() { if writable, record != nil { confirmation = true } }
    func cancelStop() { confirmation = false }
    func confirmStop() { guard writable, confirmation else { return }; advancing = false; view = nil; run { epoch in try await self.accept(self.client.stop(), epoch) } }
    func pause() {
        generation += 1; let interrupted = work, previous = forgetting; interrupted?.cancel(); work = nil
        busy = false; ready = false; advancing = false; view = nil; selectedMedia = ""; confirmation = false; instructions = Self.defaultInstructions
        forgetting = Task { await previous?.value; await interrupted?.value; await client.forgetContext() }
    }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value; await forgetting?.value }
}
