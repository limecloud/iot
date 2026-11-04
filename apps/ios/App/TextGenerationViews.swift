import SwiftUI
import LimeIoTKit

struct TextGenerationView: View {
    @ObservedObject var conversation: TextGenerationStore
    var body: some View { Form { TextGenerationSections(conversation: conversation) }.navigationTitle("本地对话") }
}

struct TextGenerationSections: View {
    @ObservedObject var conversation: TextGenerationStore
    var speech: SpeechStore? = nil
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Section("本地对话") {
                if !conversation.message.isEmpty { Text(conversation.message).font(.footnote).foregroundStyle(Palette.amber11) }
                Button("读取对话状态", action: conversation.refresh).disabled(conversation.busy || !conversation.online)
                if conversation.capabilities?.configured == false { Text("网关尚未配置本地文字模型").font(.footnote).foregroundStyle(Palette.sand11) }
                if conversation.capabilities?.configured == true {
                    TextField("消息", text: Binding(get: { conversation.prompt }, set: conversation.setPrompt), axis: .vertical).lineLimit(3...6).privacySensitive().disabled(!conversation.editable).accessibilityIdentifier("text-prompt")
                    Button("发送", action: conversation.generate).disabled(!conversation.canGenerate).accessibilityIdentifier("text-generate")
                    Button("开始新对话", action: conversation.startNew).disabled(!conversation.editable)
                    if conversation.messages.count >= 15 { Text("本轮上下文已满，请开始新对话").font(.footnote).foregroundStyle(Palette.sand11) }
                }
            if !conversation.messages.isEmpty {
                ForEach(Array(conversation.messages.enumerated()), id: \.offset) { _, item in VStack(alignment: .leading, spacing: 8) { Text(item.role == "user" ? "你" : "助手").font(.footnote).foregroundStyle(Palette.sand11); Text(item.content).textSelection(.enabled).privacySensitive() } }
            }
            if !conversation.records.isEmpty {
                ForEach(conversation.records.reversed()) { record in VStack(alignment: .leading, spacing: 8) {
                    Text(record.statusText)
                    if conversation.messages.isEmpty, let text = conversation.text(for: record.id) { Text(text).textSelection(.enabled).privacySensitive().accessibilityIdentifier("text-result") }
                    if let speech, conversation.text(for: record.id) != nil { VoiceAnswerButton(conversation: conversation, speech: speech, key: record.id) }
                    DisclosureGroup("任务详情") { Text(record.id).font(.footnote).textSelection(.enabled) }
                    if record.rejectedCode == nil { Button("查询原任务") { conversation.recover(record.id) }.disabled(conversation.busy || !conversation.online) }
                    if record.canDiscard { Button(record.status == "succeeded" ? "清除回答" : "放弃输出", role: .destructive) { conversation.requestDiscard(record.id) }.disabled(!conversation.writable) }
                } }
            }
        }
            .confirmationDialog(conversation.clearingSuccess ? "清除此回答？" : "放弃此生成输出？", isPresented: Binding(get: { conversation.confirmation != nil }, set: { if !$0 { conversation.cancelDiscard() } }), titleVisibility: .visible) {
                Button(conversation.clearingSuccess ? "清除回答" : "放弃输出", role: .destructive, action: conversation.confirmDiscard).disabled(!conversation.writable)
                Button("取消", role: .cancel, action: conversation.cancelDiscard)
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { conversation.pause(); return }
                conversation.refresh()
                while !Task.isCancelled { do { try await Task.sleep(for: .seconds(1)) } catch { break }; conversation.poll() }
            }
            .onChange(of: conversation.online) { _, online in if online { conversation.refresh() } }
            .onDisappear { conversation.pause() }
    }
}

private struct VoiceAnswerButton: View {
    @ObservedObject var conversation: TextGenerationStore
    @ObservedObject var speech: SpeechStore
    let key: String
    var body: some View {
        Button("带入语音合成") { if let text = conversation.text(for: key) { _ = speech.prepareAnswer(text) } }
            .disabled(!conversation.online || !speech.writable || speech.pending || speech.capabilities?.configured != true)
            .accessibilityIdentifier("text-use-speech")
    }
}
