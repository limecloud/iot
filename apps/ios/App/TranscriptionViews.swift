import SwiftUI
import LimeIoTKit

struct TranscriptionSection: View {
    @ObservedObject var transcription: TranscriptionStore
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Section("语音识别") {
            if !transcription.message.isEmpty { Text(transcription.message).font(.footnote).foregroundStyle(Palette.amber11).accessibilityIdentifier("transcription-message") }
            Button("读取识别状态") { transcription.refresh() }.disabled(transcription.busy || !transcription.online)
            if transcription.capabilities?.configured == false { Text("网关尚未配置本地识别服务").font(.footnote).foregroundStyle(Palette.sand11) }
            if transcription.capabilities?.configured == true {
                Picker("音频", selection: Binding(get: { transcription.selectedMedia }, set: transcription.selectMedia)) {
                    Text("请选择已上传的音频").tag("")
                    ForEach(transcription.sources) { Text($0.id).tag($0.id) }
                }.disabled(!transcription.writable || transcription.pending)
                Picker("识别语言", selection: Binding(get: { transcription.language }, set: transcription.selectLanguage)) {
                    Text("自动").tag("auto"); Text("中文").tag("zh"); Text("英语").tag("en")
                }.disabled(!transcription.writable || transcription.pending)
                Button("识别音频", action: transcription.generate).disabled(!transcription.canGenerate).accessibilityIdentifier("transcription-generate")
            }
            ForEach(transcription.records.reversed()) { record in
                VStack(alignment: .leading, spacing: 8) {
                    Text(record.statusText).font(.body)
                    if let text = transcription.text(for: record.id) { Text(text.isEmpty ? "未识别到语音" : text).font(.body).textSelection(.enabled).privacySensitive().accessibilityIdentifier("transcription-result") }
                    DisclosureGroup("任务详情") { Text(record.id).font(.footnote).textSelection(.enabled) }
                    if record.rejectedCode == nil { Button("查询原任务") { transcription.recover(record.id) }.disabled(transcription.busy || !transcription.online) }
                    if ["running", "unknown"].contains(record.status) { Button("放弃输出", role: .destructive) { transcription.requestDiscard(record.id) }.disabled(!transcription.writable) }
                }
            }
        }
        .confirmationDialog("放弃此识别输出？", isPresented: Binding(get: { transcription.confirmation != nil }, set: { if !$0 { transcription.cancelDiscard() } }), titleVisibility: .visible) {
            Button("放弃输出", role: .destructive, action: transcription.confirmDiscard).disabled(!transcription.writable)
            Button("取消", role: .cancel, action: transcription.cancelDiscard)
        } message: { Text("外部引擎可能继续计算。") }
        .task(id: scenePhase) {
            guard scenePhase == .active else { transcription.pause(); return }
            transcription.refresh()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(1)) } catch { break }; transcription.poll() }
        }
        .onChange(of: transcription.online) { _, online in if online { transcription.refresh() } }
        .onDisappear { transcription.pause() }
    }
}
