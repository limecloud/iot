import SwiftUI
import LimeIoTKit

struct ObservationView: View {
    @ObservedObject var sources: ObservationStore
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Form {
            if let commissioning = sources.commissioning { ZigbeeSections(state: commissioning) }
            Section {
                if !sources.message.isEmpty { Text(sources.message).font(.footnote).foregroundStyle(Palette.amber11) }
                Button("读取接入状态", action: sources.refresh).disabled(sources.busy || !sources.online)
            }
            Section("添加设备") {
                if sources.coordinators.isEmpty { Text("请先在网关配置 Zigbee 协调器").font(.footnote) }
                else {
                    Picker("协调器", selection: Binding(get: { sources.coordinator }, set: sources.setCoordinator)) { ForEach(sources.coordinators) { Text($0.id).tag($0.id) } }
                    Button("发现已有设备", action: sources.discover).disabled(!sources.writable).accessibilityIdentifier("observation-discover")
                    if let discovery = sources.discovery {
                        Text("协调器邻居记录，可能遗漏设备").font(.footnote).foregroundStyle(Palette.sand11)
                        if discovery.items.isEmpty { Text("未发现邻居记录").font(.footnote) }
                        ForEach(discovery.items) { neighbor in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(neighbor.id).font(.footnote)
                                Button("读取端点") { sources.readEndpoints(neighbor.id) }.disabled(!sources.writable)
                            }
                        }
                    }
                    if let endpoints = sources.endpoints {
                        if endpoints.items.isEmpty { Text("未读取到端点").font(.footnote) }
                        ForEach(endpoints.items) { endpoint in
                            HStack {
                                Text("端点 \(endpoint.id)")
                                Spacer()
                                if endpoint.supportsEnvironment || endpoint.supportsOnOff { Button("查询此端点") { sources.queryEndpoint(endpoint.id) }.disabled(!sources.writable) }
                                else { Text("暂不支持").font(.footnote).foregroundStyle(Palette.sand11) }
                            }
                        }
                    }
                    TextField("设备 IEEE，16 位小写十六进制", text: Binding(get: { sources.ieee }, set: sources.setIEEE)).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("observation-ieee")
                    TextField("端点", text: Binding(get: { sources.endpoint }, set: sources.setEndpoint)).keyboardType(.numberPad)
                    Picker("设备类型", selection: Binding(get: { sources.profile }, set: sources.setProfile)) { Text("温湿度传感器").tag(ObservationProfile.environment); Text("开关").tag(ObservationProfile.onOff) }
                    TextField("设备编号", text: Binding(get: { sources.device }, set: sources.setDevice)).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("查询设备", action: sources.query).disabled(!sources.writable).accessibilityIdentifier("observation-query")
                }
            }.disabled(sources.busy || !sources.online)
            if let review = sources.review {
                Section(review.candidate == nil ? "撤销接入" : "核对设备") {
                    LabeledContent("设备编号", value: review.binding.device)
                    if let candidate = review.candidate {
                        LabeledContent("型号", value: candidate.model)
                        LabeledContent("厂商", value: candidate.manufacturer)
                        LabeledContent("IEEE", value: candidate.ieee)
                        LabeledContent("接入权限", value: candidate.profile == .onOff ? "读取和控制电源" : "只读温湿度")
                        Text("协议响应尚未认证设备身份").font(.footnote).foregroundStyle(Palette.sand11)
                    }
                    Button(review.candidate == nil ? "确认撤销" : "确认添加", action: sources.confirm).disabled(!sources.canConfirm).accessibilityIdentifier("observation-confirm")
                    Button("取消", action: sources.cancelReview)
                }
            }
            if !sources.staticDevices.isEmpty {
                Section("配置接入") { ForEach(sources.staticDevices) { Text($0.id).font(.body) } }
            }
            if !sources.bindings.isEmpty {
                Section("托管设备") {
                    ForEach(sources.bindings, id: \.device) { binding in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(binding.device)
                            Text(binding.active ? "已接入" : "已撤销").font(.footnote).foregroundStyle(Palette.sand11)
                            if binding.active { Button("撤销接入") { sources.reviewRevoke(binding.device) }.disabled(!sources.writable) }
                            else { Button("重新接入") { sources.rebind(binding) }.disabled(!sources.writable) }
                        }
                    }
                }
            }
            if !sources.records.isEmpty {
                Section("接入记录") { ForEach(sources.records.reversed()) { record in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(record.device + " " + record.statusText)
                        DisclosureGroup("原请求") { Text(record.id).font(.footnote).textSelection(.enabled) }
                        Button("查询原操作") { sources.recover(record.id) }.disabled(sources.busy || !sources.online)
                    }
                } }
            }
        }.navigationTitle("Zigbee 设备")
            .task(id: scenePhase) {
                guard scenePhase == .active else { sources.pause(); return }
                sources.refresh()
                while !Task.isCancelled { do { try await Task.sleep(for: .seconds(1)) } catch { break }; sources.poll() }
            }
            .onChange(of: sources.online) { _, online in if online { sources.refresh() } }
            .onDisappear { sources.pause() }
    }
}
