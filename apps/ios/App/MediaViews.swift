import SwiftUI
import UniformTypeIdentifiers
import LimeIoTKit

struct MediaView: View {
    @ObservedObject var media: MediaStore
    let names: [String: String]
    let speech: SpeechStore?
    let transcription: TranscriptionStore?
    let conversation: TextGenerationStore?
    let voiceTurn: VoiceTurnStore?
    let companion: CompanionStore?
    @Environment(\.scenePhase) private var scenePhase
    @State private var picker = false
    @State private var reading = false
    @State private var fileTask: Task<Void, Never>?
    @State private var fileGeneration = UUID()
    @StateObject private var recorder: RecordingStore
    @State private var permissionTask: Task<Void, Never>?
    init(media: MediaStore, names: [String: String], speech: SpeechStore?, transcription: TranscriptionStore?, conversation: TextGenerationStore? = nil, voiceTurn: VoiceTurnStore? = nil, companion: CompanionStore? = nil) {
        self.media = media; self.names = names; self.speech = speech; self.transcription = transcription; self.conversation = conversation
        self.voiceTurn = voiceTurn
        self.companion = companion
        _recorder = StateObject(wrappedValue: RecordingStore(factory: { AppleRecordingInput() }, completed: media.selectRecording, cleared: media.clearRecording))
    }
    private func recordingAvailability() { recorder.setAvailable(scenePhase == .active && media.online && media.page?.configured == true) }
    private func cancelRecording() { permissionTask?.cancel(); permissionTask = nil; recorder.cancel() }
    private func startRecording() {
        stopReading()
        guard let epoch = recorder.request() else { return }
        permissionTask = Task { let granted = await AppleRecordingInput.requestPermission(); if !Task.isCancelled { recorder.authorize(epoch, granted: granted) } }
    }
    private func stopReading() { fileGeneration = UUID(); fileTask?.cancel(); fileTask = nil; reading = false }
    private func readFile(_ result: Result<[URL], Error>) {
        stopReading()
        guard scenePhase == .active, media.online, !recorder.busy else { return }
        guard case .success(let urls) = result, let url = urls.first else {
            if case .failure(let error) = result { media.fileFailure(error) }; return
        }
        reading = true; let epoch = fileGeneration
        fileTask = Task {
            defer { if epoch == fileGeneration { reading = false; fileTask = nil } }
            do {
                let file = try await MediaFile.read(url)
                await media.waitForIdle(); try Task.checkCancellation()
                if epoch == fileGeneration { media.selectFile(name: file.name, data: file.data) }
            } catch {
                await media.waitForIdle()
                if epoch == fileGeneration { media.fileFailure(error) }
            }
        }
    }
    var body: some View {
        Form {
            if !media.online { Text("连接中断，当前显示上次观测").font(.footnote).foregroundStyle(Palette.amber11) }
            if !media.message.isEmpty { Text(media.message).font(.footnote).foregroundStyle(Palette.amber11).accessibilityIdentifier("media-message") }
            Button(media.busy ? "正在读取" : "读取音频状态") { media.refresh() }.disabled(media.busy || !media.online || reading || recorder.busy)
            if media.page?.configured == false { Text("此网关未启用音频服务").font(.footnote).foregroundStyle(Palette.sand11) }
            Section("上传音频") {
                if !recorder.busy {
                    Button("开始录音", action: startRecording).disabled(!media.writable || reading).accessibilityIdentifier("recording-start")
                } else {
                    Text(recorder.phase == .recording ? "已录音 \(recorder.seconds) 秒 / 60 秒" : recorder.phase == .requesting ? "等待麦克风授权" : "正在处理录音").font(.footnote).foregroundStyle(Palette.sand11).accessibilityIdentifier("recording-status")
                    if recorder.phase == .recording { Button("完成录音", action: recorder.finish).accessibilityIdentifier("recording-finish") }
                    Button("取消录音", action: cancelRecording).accessibilityIdentifier("recording-cancel")
                }
                if !recorder.message.isEmpty { Text(recorder.message).font(.footnote).foregroundStyle(Palette.amber11) }
                Button(reading ? "正在读取文件" : "选择 WAV 文件") { picker = true }.disabled(!media.writable || reading || recorder.busy)
                if !media.fileName.isEmpty { Text(media.fileName).font(.body) }
                Text("16 位 PCM，最多 4 MiB、60 秒").font(.footnote).foregroundStyle(Palette.sand11)
                Picker("保留时间", selection: Binding(get: { media.retainSeconds }, set: media.setRetention)) { Text("10 分钟").tag(600); Text("1 小时").tag(3600); Text("24 小时").tag(86400) }.disabled(!media.writable || reading || recorder.busy)
                Button("上传音频", action: media.upload).disabled(!media.canUpload || reading || recorder.busy).accessibilityIdentifier("media-upload")
            }
            if let voiceTurn { VoiceTurnSection(turn: voiceTurn, media: media).disabled(recorder.busy || reading) }
            if let companion { CompanionSection(companion: companion, media: media).disabled(recorder.busy || reading) }
            if let transcription { TranscriptionSection(transcription: transcription, conversation: conversation) }
            if let conversation { TextGenerationSections(conversation: conversation, speech: speech) }
            if let speech { SpeechSection(speech: speech) }
            Section("音频") {
                if media.page?.items.isEmpty != false { Text("暂无音频").font(.body).foregroundStyle(Palette.sand11) }
                ForEach(media.page?.items ?? []) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item.id).font(.body).textSelection(.enabled)
                        Text(item.deletedAt != nil ? "已删除" : item.available ? "可用" : "不可用").font(.footnote).foregroundStyle(Palette.sand11)
                        Text(String(format: "%.1f 秒 / %d 字节", item.durationSeconds, item.byteLength)).font(.footnote).foregroundStyle(Palette.sand11)
                        Text("到期：" + item.expiresAt).font(.footnote).foregroundStyle(Palette.sand11)
                        if item.deletedAt == nil { Button("删除音频", role: .destructive) { media.requestDelete(item.id) }.disabled(!media.writable || reading) }
                    }
                }
            }.disabled(recorder.busy)
            Section("音箱授权") {
                Picker("音频", selection: Binding(get: { media.selectedMedia }, set: media.selectMedia)) {
                    Text("请选择音频").tag("")
                    ForEach((media.page?.items ?? []).filter(\.available)) { Text($0.id).tag($0.id) }
                }.disabled(!media.writable || reading)
                Picker("音箱", selection: Binding(get: { media.selectedTarget }, set: media.selectTarget)) {
                    Text("请选择音箱").tag("")
                    ForEach(media.targets) { Text(names[$0.deviceId] ?? $0.deviceId).tag($0.deviceId) }
                }.disabled(!media.writable || reading)
                if media.targets.isEmpty { Text("请先在家庭网页绑定支持音频的音箱").font(.footnote).foregroundStyle(Palette.sand11) }
                Picker("授权期限", selection: Binding(get: { media.grantSeconds }, set: media.setGrantDuration)) { Text("30 秒").tag(30); Text("5 分钟").tag(300); Text("10 分钟").tag(600) }.disabled(!media.writable || reading)
                Toggle("允许所选音箱读取此音频", isOn: Binding(get: { media.approved }, set: media.approve)).disabled(!media.writable || reading || media.selectedMedia.isEmpty || media.selectedTarget.isEmpty)
                Button("授权音箱", action: media.grant).disabled(!media.canGrant || reading).accessibilityIdentifier("media-grant")
                Text("授权后请在设备页播放").font(.footnote).foregroundStyle(Palette.sand11)
            }.disabled(recorder.busy)
            Section("已有授权") {
                if media.page?.grants.isEmpty != false { Text("暂无授权").font(.body).foregroundStyle(Palette.sand11) }
                ForEach(media.page?.grants ?? []) { grant in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(names[grant.deviceId] ?? grant.deviceId).font(.body)
                        Text(grant.mediaId).font(.footnote).textSelection(.enabled)
                        Text(grant.active ? "当前有效" : "当前无效").font(.footnote).foregroundStyle(Palette.sand11)
                        Text("到期：" + grant.expiresAt).font(.footnote).foregroundStyle(Palette.sand11)
                        if case .object(let document) = grant.document, document["revoked_at"] == .null {
                            Button("撤销授权") { media.revoke(grant.id) }.disabled(!media.writable || reading)
                        }
                    }
                }
            }.disabled(recorder.busy)
            Section("音频原操作") {
                ForEach(media.records.reversed()) { record in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(record.statusText).font(.body)
                        Text(record.id).font(.footnote).textSelection(.enabled)
                        DisclosureGroup("原操作详情") { Text(OtaJSON.canonical(.object(["original": record.original, "result": record.result ?? .null]))).font(.footnote).textSelection(.enabled) }
                        Button("查询音频原操作") { media.recover(record.id) }.disabled(media.busy || !media.online || reading)
                    }
                }
            }.disabled(recorder.busy)
        }.navigationTitle("音频")
            .fileImporter(isPresented: $picker, allowedContentTypes: [.wav], allowsMultipleSelection: false, onCompletion: readFile)
            .confirmationDialog("删除此音频及其授权？", isPresented: Binding(get: { media.deletion != nil }, set: { if !$0 { media.cancelDelete() } }), titleVisibility: .visible) {
                Button("删除音频", role: .destructive, action: media.confirmDelete).disabled(!media.writable)
                Button("取消", role: .cancel, action: media.cancelDelete)
            }
            .task(id: scenePhase) { recordingAvailability(); if scenePhase == .active { media.refresh() } else { cancelRecording(); stopReading(); media.pause() } }
            .onChange(of: media.online) { _, online in recordingAvailability(); if online { media.refresh() } else { cancelRecording(); stopReading() } }
            .onChange(of: media.page?.configured) { _, _ in recordingAvailability() }
            .onDisappear { recorder.setAvailable(false); cancelRecording(); stopReading(); media.pause() }
    }
}

struct MediaSettingsLinks: View {
    @EnvironmentObject private var home: HomeStore
    @ObservedObject var media: MediaStore
    var body: some View {
        NavigationLink("音频") { MediaView(media: media, names: Dictionary(uniqueKeysWithValues: (home.snapshot?.devices ?? []).map { ($0.id, home.snapshot?.name($0) ?? $0.id) }), speech: home.speech, transcription: home.transcription, conversation: home.textGeneration, voiceTurn: home.voiceTurn, companion: home.companion) }
        if let vision = home.vision { NavigationLink("图片观察") { VisionView(vision: vision) } }
        Button("退出登录", role: .destructive) { Task { await home.logout() } }.disabled(home.busy || home.firmware?.busy == true || media.busy || home.speech?.busy == true || home.transcription?.busy == true || home.vision?.busy == true || home.textGeneration?.busy == true || home.voiceTurn?.busy == true || home.companion?.busy == true)
    }
}
