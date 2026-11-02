import SwiftUI
import LimeIoTKit

struct FirmwareView: View {
    @ObservedObject var firmware: FirmwareStore
    let devices: [Device]
    @State private var material = ""
    @State private var fingerprint = ""
    @State private var manifest = ""
    @State private var deviceId = ""
    @State private var trustId = ""
    @State private var revoke: FirmwareTrust?
    private var writable: Bool { firmware.ready && !firmware.busy }
    var body: some View {
        List {
            if !firmware.message.isEmpty { Text(firmware.message).font(.footnote).foregroundStyle(Palette.amber11).accessibilityAddTraits(.updatesFrequently) }
            Button(firmware.busy ? "正在读取" : "读取升级状态") { Task { await firmware.refresh() } }.disabled(firmware.busy)
            Section("固件信任") {
                TextField("固件信任材料", text: $material, axis: .vertical).lineLimit(3...6).font(.footnote).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("独立核对的固件公钥指纹", text: $fingerprint).font(.footnote).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("信任固件签名者") { let input = material, expected = fingerprint; Task { await firmware.submit { try OtaChanges.trust(material: input, fingerprint: expected) } } }.disabled(!writable || material.isEmpty || fingerprint.isEmpty)
                ForEach(firmware.trusts) { trust in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(trust.active ? "已信任" : "已撤销")
                        Text(field(trust.document, ["trust", "signing_key_id"])).font(.footnote).textSelection(.enabled)
                        DisclosureGroup("信任范围") { Text(trust.document.jsonText).font(.footnote).textSelection(.enabled) }
                        if trust.active { Button("撤销固件信任", role: .destructive) { revoke = trust }.disabled(!writable) }
                    }
                }
            }
            Section("创建升级计划") {
                Picker("升级设备", selection: $deviceId) { Text("选择设备").tag(""); ForEach(devices) { Text($0.deviceId).tag($0.id) } }
                Picker("固件签名者", selection: $trustId) { Text("选择签名者").tag(""); ForEach(firmware.trusts.filter(\.active)) { Text(field($0.document, ["trust", "signing_key_id"])).tag($0.id) } }
                TextField("签名固件清单", text: $manifest, axis: .vertical).lineLimit(3...6).font(.footnote).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("创建升级计划") { let d = deviceId, t = trustId, m = manifest; Task { await firmware.submit { try OtaChanges.plan(deviceId: d, trustId: t, manifest: m) } } }.disabled(!writable || deviceId.isEmpty || manifest.isEmpty || !firmware.trusts.contains { $0.id == trustId && $0.active })
                Text("计划有效 10 分钟，批准后需另行开始安装").font(.footnote).foregroundStyle(Palette.sand11)
            }
            Section("升级任务") {
                if firmware.tasks.isEmpty { Text("暂无升级任务").font(.footnote).foregroundStyle(Palette.sand11) }
                ForEach(firmware.tasks) { task in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(task.deviceId + " → " + task.targetVersion)
                        Text(task.statusText).font(.footnote).foregroundStyle(Palette.sand11)
                        Button("读取当前任务") { Task { await firmware.review(task.id) } }.disabled(!writable)
                    }
                }
            }
            if let task = firmware.reviewed {
                Section("核对升级任务") {
                    LabeledContent("设备", value: task.deviceId)
                    LabeledContent("当前版本", value: field(task.document, ["baseline", "device", "firmware_version"]))
                    LabeledContent("目标版本", value: task.targetVersion)
                    LabeledContent("目标板卡", value: field(task.document, ["manifest", "statement", "target", "board"]))
                    LabeledContent("安全代次", value: field(task.document, ["manifest", "statement", "security_epoch"]))
                    LabeledContent("镜像字节数", value: field(task.document, ["manifest", "statement", "size_bytes"]))
                    LabeledContent("当前状态", value: task.statusText)
                    Text(field(task.document, ["manifest_digest"])).font(.footnote).textSelection(.enabled)
                    Text(field(task.document, ["expires_at"])).font(.footnote)
                    DisclosureGroup("完整任务与签名清单") { Text(task.document.jsonText).font(.footnote).textSelection(.enabled) }
                    ForEach(task.allowedActions, id: \.self) { type in
                        Button(OtaChanges.labels[type] ?? type) { Task { await firmware.transition(type) } }.disabled(!writable)
                    }
                }
            }
            Section("升级原操作") {
                ForEach(firmware.records.reversed()) { record in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(record.statusText)
                        Text(record.id).font(.footnote).textSelection(.enabled)
                        DisclosureGroup("原请求与决定") { Text(record.request.jsonText).font(.footnote).textSelection(.enabled); if let result = record.result { Text(result.jsonText).font(.footnote).textSelection(.enabled) } }
                        Button("查询升级原操作") { Task { await firmware.recover(record.id) } }.disabled(firmware.busy)
                    }
                }
            }
        }.navigationTitle("固件升级")
            .task { await firmware.refresh() }
            .confirmationDialog("撤销固件信任", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } }), titleVisibility: .visible) {
                if let trust = revoke {
                    Button("确认撤销固件信任", role: .destructive) { revoke = nil; Task { await firmware.submit { OtaChanges.revoke(trust: trust) } } }
                }
            }
    }
    private func field(_ value: JSONValue, _ path: [String]) -> String {
        var current = value
        for key in path { guard case .object(let object) = current, let next = object[key] else { return "" }; current = next }
        return current.text
    }
}
