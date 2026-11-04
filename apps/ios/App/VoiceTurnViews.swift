import SwiftUI
import LimeIoTKit

struct VoiceTurnSection: View {
    @ObservedObject var turn: VoiceTurnStore
    @ObservedObject var media: MediaStore
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Section("语音对话") {
            if !turn.message.isEmpty { Text(turn.message).font(.footnote).foregroundStyle(Palette.amber11) }
            Picker("录音", selection: Binding(get: { turn.selectedMedia }, set: turn.selectMedia)) {
                Text("请选择录音").tag("")
                ForEach((media.page?.items ?? []).filter(\.available)) { Text($0.id).tag($0.id) }
            }.disabled(!turn.writable)
            Picker("声音", selection: Binding(get: { turn.voice }, set: turn.selectVoice)) {
                ForEach(turn.capabilities?.speech.voices ?? [], id: \.self) { Text($0).tag($0) }
            }.disabled(!turn.writable)
            Button("开始语音对话", action: turn.start).disabled(!turn.canStart).accessibilityIdentifier("voice-turn-start")
            Text(turn.statusText).font(.footnote).foregroundStyle(Palette.sand11)
            if let text = turn.visible?.transcript { Text(text).font(.body).textSelection(.enabled) }
            if let text = turn.visible?.answer { Text(text).font(.body).textSelection(.enabled) }
            if let id = turn.visible?.mediaID {
                Button("选作播放音频") { Task { await media.useGenerated(id) } }.disabled(!media.writable || !turn.writable)
            }
            if let record = turn.record {
                Text(record.id).font(.footnote).textSelection(.enabled)
                Button("查询原回合", action: turn.recover).disabled(!turn.writable)
                Button("继续原回合", action: turn.continueTurn).disabled(!turn.canContinue)
                Button("停止回合", role: .destructive, action: turn.requestStop).disabled(!turn.writable)
            }
            Button("读取语音服务", action: turn.refresh).disabled(!turn.writable)
        }
        .confirmationDialog("停止回合并清除生成的回答？", isPresented: Binding(get: { turn.confirmation }, set: { if !$0 { turn.cancelStop() } }), titleVisibility: .visible) {
            Button("停止回合", role: .destructive, action: turn.confirmStop)
            Button("取消", role: .cancel, action: turn.cancelStop)
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { turn.pause(); return }
            turn.refresh()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(1)) } catch { break }; turn.poll() }
        }
        .onChange(of: turn.online) { _, online in if online { turn.refresh() } }
        .onDisappear { turn.pause() }
    }
}
