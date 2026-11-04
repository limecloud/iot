import SwiftUI
import LimeIoTKit

struct CompositionView: View {
    @EnvironmentObject private var home: HomeStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var composition: CompositionStore
    init(client: CompositionClient, authFailure: @escaping (Error) -> Void) { _composition = StateObject(wrappedValue: CompositionStore(client: client, authFailure: authFailure)) }
    private var devices: [Device] { home.snapshot?.devices ?? [] }
    private var fingerprint: String { devices.map { "\($0.id):\($0.modelRevision):\($0.ready)" }.sorted().joined(separator: ",") }
    private func name(_ id: String) -> String { devices.first { $0.id == id }.map { home.snapshot?.name($0) ?? id } ?? id }
    var body: some View {
        Form {
            if !composition.message.isEmpty { Section { Text(composition.message).font(.footnote).foregroundStyle(Palette.sand11) } }
            if let record = composition.record {
                Section(record.compiled.package.name) {
                    Text(record.state == "acknowledged" ? "启用回执已确认" : record.state == "rejected" ? "提交未获接受" : "原提交结果待核实")
                    Button("查询当前部署", action: composition.query).disabled(!composition.writable)
                    if record.state != "attempted" { Button("准备其他组合", action: composition.prepareAnother).disabled(!composition.writable) }
                    DisclosureGroup("原提交内容") { Text(record.json).font(.footnote).textSelection(.enabled) }
                }
            } else {
                Section {
                    Picker("组合包", selection: Binding(get: { composition.custom }, set: composition.setCustom)) { Text("触摸伴读灯").tag(false); Text("自定义组合包").tag(true) }.disabled(!composition.canEdit)
                    if composition.custom {
                        Text("组合包 JSON").font(.footnote)
                        TextEditor(text: Binding(get: { composition.source }, set: composition.setSource)).font(.footnote).frame(minHeight: 160).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(!composition.canEdit)
                        if !composition.source.isEmpty && composition.manifest == nil { Text("组合包格式不正确").font(.footnote).foregroundStyle(Palette.amber11) }
                    }
                    if let manifest = composition.manifest {
                        ForEach(manifest.roles, id: \.self) { role in
                            Picker(["touch": "触摸模块", "light": "灯光模块"][role] ?? role, selection: Binding(get: { composition.bindings[role] ?? "" }, set: { composition.bind(role, device: $0) })) {
                                Text("选择兼容设备").tag("")
                                ForEach(devices.filter { $0.ready && $0.modelRevision == manifest.modelRevision(role) }) { device in Text(name(device.id) + "（" + device.id + "）").tag(device.id) }
                            }.disabled(!composition.canEdit)
                        }
                    }
                    Button(composition.busy ? "正在处理" : "预演组合", action: composition.plan).disabled(!composition.canPlan).accessibilityIdentifier("composition-plan")
                    Button("启用组合", action: composition.deploy).disabled(!composition.canDeploy).accessibilityIdentifier("composition-deploy")
                }
                if let preview = composition.preview {
                    Section("预演结果") {
                        ForEach(Array(((try? preview.compiled.typedRule.actions) ?? []).enumerated()), id: \.offset) { item in Text(name(item.element.device) + " " + item.element.operation.summary).font(.footnote) }
                        DisclosureGroup("组合与权限内容") { Text(preview.json).font(.footnote).textSelection(.enabled) }
                    }
                }
            }
            Button("读取组合状态", action: composition.refresh).disabled(!home.online || composition.busy || composition.blocked)
        }
        .navigationTitle("使用组合包")
        .task(id: scenePhase) {
            guard scenePhase == .active else { composition.pause(); return }
            composition.updateDevices(devices); composition.setOnline(home.online); composition.refresh()
            while !Task.isCancelled { do { try await Task.sleep(for: .seconds(1)) } catch { break }; composition.poll() }
        }
        .onChange(of: home.online) { _, online in composition.setOnline(online); if online { composition.refresh() } }
        .onChange(of: fingerprint) { _, _ in composition.updateDevices(devices); if !composition.ready { composition.refresh() } }
        .onDisappear { composition.pause() }
    }
}
