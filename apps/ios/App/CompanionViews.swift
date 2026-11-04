import SwiftUI
import LimeIoTKit

struct CompanionSection: View {
    @ObservedObject var companion: CompanionStore
    @ObservedObject var media: MediaStore
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Section("陪伴") {
            if !companion.message.isEmpty { Text(companion.message).font(.footnote).foregroundStyle(Palette.amber11) }
            TextField("角色说明", text: Binding(get: { companion.instructions }, set: companion.setInstructions), axis: .vertical).lineLimit(3...6).disabled(!companion.canEdit)
            Picker("声音", selection: Binding(get: { companion.voice }, set: companion.selectVoice)) {
                ForEach(companion.capabilities?.speech.voices ?? [], id: \.self) { Text($0).tag($0) }
            }.disabled(!companion.canEdit)
            Text("每次会话最多 4 轮、10 分钟").font(.footnote).foregroundStyle(Palette.sand11)
            Button("开始陪伴", action: companion.start).disabled(!companion.canStart).accessibilityIdentifier("companion-start")
            Text(companion.statusText).font(.footnote).foregroundStyle(Palette.sand11)
            if companion.record != nil {
                Picker("录音", selection: Binding(get: { companion.selectedMedia }, set: companion.selectMedia)) {
                    Text("请选择录音").tag("")
                    ForEach((media.page?.items ?? []).filter(\.available)) { Text($0.id).tag($0.id) }
                }.disabled(!companion.writable)
                Button("发送本轮录音", action: companion.reply).disabled(!companion.canReply).accessibilityIdentifier("companion-reply")
                if let text = companion.visible?.transcript { Text(text).font(.body).textSelection(.enabled) }
                if let text = companion.visible?.answer { Text(text).font(.body).textSelection(.enabled) }
                if let id = companion.visible?.mediaID { Button("选作播放音频") { Task { await media.useGenerated(id) } }.disabled(!media.writable || !companion.writable) }
                Button("查询原会话", action: companion.recover).disabled(!companion.writable)
                Button("继续原回合", action: companion.continueSession).disabled(!companion.canContinue)
                Button("停止会话", role: .destructive, action: companion.requestStop).disabled(!companion.writable)
            }
            Button("读取陪伴状态", action: companion.refresh).disabled(!companion.writable)
        }
        .confirmationDialog("停止会话并清除生成的回答？", isPresented: Binding(get: { companion.confirmation }, set: { if !$0 { companion.cancelStop() } }), titleVisibility: .visible) {
            Button("停止会话", role: .destructive, action: companion.confirmStop)
            Button("取消", role: .cancel, action: companion.cancelStop)
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { companion.pause(); return }
            companion.refresh()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(1)) } catch { break }; companion.poll() }
        }
        .onChange(of: companion.online) { _, online in if online { companion.refresh() } }
        .onDisappear { companion.pause() }
    }
}
