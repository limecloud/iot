import SwiftUI
import LimeIoTKit

struct ZigbeeSections: View {
    @ObservedObject var state: ZigbeeStore
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Group {
            Section("Zigbee 入网") {
                if !state.message.isEmpty { Text(state.message).font(.footnote).foregroundStyle(Palette.amber11) }
                Button("读取入网状态", action: state.refresh).disabled(state.busy || !state.online)
                if state.coordinators.isEmpty { Text("尚未配置可管理的协调器").font(.footnote) }
                else {
                    Picker("入网协调器", selection: Binding(get: { state.coordinator }, set: state.setCoordinator)) { ForEach(state.coordinators) { Text($0.id).tag($0.id) } }.disabled(state.busy || !state.online)
                    TextField("开放时长（秒）", text: Binding(get: { state.seconds }, set: state.setSeconds)).keyboardType(.numberPad).disabled(state.busy || !state.online)
                    Button("开放入网") { state.prepare() }.disabled(!state.writable).accessibilityIdentifier("zigbee-open")
                    Button("关闭入网") { state.prepare(close: true) }.disabled(!state.writable).accessibilityIdentifier("zigbee-close")
                }
            }
            if let review = state.review {
                Section(review.preparation.seconds == 0 ? "确认关闭入网" : "确认开放入网") {
                    LabeledContent("协调器", value: review.preparation.coordinator.id)
                    LabeledContent("协调器 IEEE", value: review.preparation.coordinator.ieee)
                    LabeledContent("操作", value: review.preparation.seconds == 0 ? "关闭入网" : "开放\(review.preparation.seconds)秒")
                    if review.preparation.seconds > 0 { Text("设备加入后仍需单独添加").font(.footnote).foregroundStyle(Palette.sand11) }
                    Button(review.preparation.seconds == 0 ? "确认关闭" : "确认开放", action: state.confirm).disabled(!state.canConfirm).accessibilityIdentifier("zigbee-confirm")
                    Button("取消入网操作", action: state.cancelReview).disabled(state.busy)
                }
            }
            if !state.entries.isEmpty {
                Section("入网操作记录") { ForEach(state.entries.reversed()) { record in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(record.seconds == 0 ? "关闭入网：\(record.coordinator)" : "开放\(record.seconds)秒：\(record.coordinator)")
                        Text(record.statusText).font(.footnote).foregroundStyle(Palette.sand11)
                        DisclosureGroup("原请求") { Text(record.id).font(.footnote).textSelection(.enabled) }
                        Button("查询原入网操作") { state.recover(record.id) }.disabled(state.busy || !state.online)
                    }
                } }
            }
        }.task(id: scenePhase) {
            guard scenePhase == .active else { state.pause(); return }; state.refresh()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(1)) } catch { break }; state.poll() }
        }.onChange(of: state.online) { _, online in if online { state.refresh() } }.onDisappear { state.pause() }
    }
}
