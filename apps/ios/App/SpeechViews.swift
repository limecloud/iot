import SwiftUI
import LimeIoTKit

struct SpeechSection: View {
    @ObservedObject var speech: SpeechStore
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Section("文字转语音") {
            if !speech.message.isEmpty { Text(speech.message).font(.footnote).foregroundStyle(Palette.amber11).accessibilityIdentifier("speech-message") }
            Button("读取语音状态") { speech.refresh() }.disabled(speech.busy || !speech.online)
            if speech.capabilities?.configured == false { Text("网关尚未配置本地语音服务").font(.footnote).foregroundStyle(Palette.sand11) }
            if speech.capabilities?.configured == true {
                TextField("文本", text: Binding(get: { speech.text }, set: speech.setText), axis: .vertical)
                    .lineLimit(3...6).autocorrectionDisabled().privacySensitive().disabled(!speech.writable || speech.pending).accessibilityIdentifier("speech-text")
                Text("\(speech.text.unicodeScalars.count) / 1000").font(.footnote).foregroundStyle(Palette.sand11)
                Picker("声音", selection: Binding(get: { speech.voice }, set: speech.selectVoice)) {
                    ForEach(speech.capabilities?.voices ?? [], id: \.self) { Text($0).tag($0) }
                }.disabled(!speech.writable || speech.pending || speech.capabilities?.voices.count == 1)
                Picker("保留时间", selection: Binding(get: { speech.retainSeconds }, set: speech.setRetention)) { Text("10 分钟").tag(600); Text("1 小时").tag(3600); Text("24 小时").tag(86400) }.disabled(!speech.writable || speech.pending)
                Button("生成音频", action: speech.generate).disabled(!speech.canGenerate).accessibilityIdentifier("speech-generate")
            }
            ForEach(speech.records.reversed()) { record in
                VStack(alignment: .leading, spacing: 8) {
                    Text(record.statusText).font(.body)
                    Text("\(record.originalCharacters) 字，\(record.originalVoice)").font(.footnote).foregroundStyle(Palette.sand11)
                    DisclosureGroup("任务详情") {
                        Text(record.id).font(.footnote).textSelection(.enabled)
                        if let id = record.mediaId { Text(id).font(.footnote).textSelection(.enabled) }
                    }
                    if record.rejectedCode == nil { Button("查询原任务") { speech.recover(record.id) }.disabled(speech.busy || !speech.online) }
                    if ["running", "unknown"].contains(record.status) { Button("放弃输出", role: .destructive) { speech.requestDiscard(record.id) }.disabled(!speech.writable) }
                }
            }
        }
        .confirmationDialog("放弃此音频输出？", isPresented: Binding(get: { speech.confirmation != nil }, set: { if !$0 { speech.cancelDiscard() } }), titleVisibility: .visible) {
            Button("放弃输出", role: .destructive, action: speech.confirmDiscard).disabled(!speech.writable)
            Button("取消", role: .cancel, action: speech.cancelDiscard)
        } message: { Text("外部引擎可能继续计算。") }
        .task(id: scenePhase) {
            guard scenePhase == .active else { speech.pause(); return }
            speech.refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
                speech.poll()
            }
        }
        .onChange(of: speech.online) { _, online in if online { speech.refresh() } }
        .onDisappear { speech.pause() }
    }
}

private extension SpeechRecord {
    var originalCharacters: Int { if case .object(let value) = original, case .integer(let count) = value["input_characters"] { count } else { 0 } }
    var originalVoice: String { if case .object(let value) = original, case .string(let name) = value["voice"] { name } else { "" } }
}
