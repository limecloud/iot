import SwiftUI
import LimeIoTKit

struct CloudRootView: View {
    @EnvironmentObject private var cloud: CloudStore
    @Environment(\.openURL) private var openURL
    var body: some View {
        Group {
            if cloud.principal != nil {
                TabView {
                    NavigationStack { cloudDevices.navigationTitle("我的设备") }.tabItem { Label("设备", systemImage: "house") }
                    NavigationStack { cloudRecords.navigationTitle("操作记录") }.tabItem { Label("操作记录", systemImage: "clock") }
                    NavigationStack { Form {
                        Section("云服务") { Text(cloud.endpoint); Text(cloud.principal?.name ?? ""); Text(cloud.online ? "已连接" : "连接中断") }
                        Button("刷新", action: { Task { await cloud.refresh() } }).disabled(cloud.busy)
                        Button("退出登录", role: .destructive) { Task { await cloud.logout() } }.disabled(cloud.busy)
                        cloudMessage
                    }.navigationTitle("设置") }.tabItem { Label("设置", systemImage: "gearshape") }
                }
            } else {
                NavigationStack { Form {
                    Section("云服务") {
                        TextField("控制面 HTTPS 地址", text: $cloud.endpoint).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().disabled(cloud.busy || cloud.pendingAuthorization)
                        if cloud.login == nil && !cloud.pendingAuthorization {
                            Button("登录", action: { Task { await cloud.begin() } }).disabled(cloud.busy || cloud.endpoint.isEmpty)
                        }
                        if cloud.login == nil {
                            Button("恢复会话", action: { Task { await cloud.restore() } }).disabled(cloud.busy || cloud.endpoint.isEmpty)
                        }
                    }
                    if let login = cloud.login {
                        Section("授权码") {
                            Text(login.userCode).font(.system(size: 28, weight: .semibold, design: .monospaced)).privacySensitive().accessibilityLabel("授权码 \(login.userCode.map(String.init).joined(separator: " "))")
                            Text("在浏览器登录控制台，输入此码并批准。").font(.system(size: 14)).foregroundStyle(Palette.sand11)
                            Button("打开浏览器") {
                                if let url = URL(string: login.verificationUri) { openURL(url) { accepted in if !accepted { cloud.browserFailed() } } }
                            }.disabled(cloud.busy)
                            if !cloud.polling { Button("继续查询", action: cloud.resumePolling).disabled(cloud.busy) }
                        }
                    }
                    if cloud.pendingAuthorization { Button("结束本次登录", role: .destructive) { Task { await cloud.cancel() } }.disabled(cloud.busy) }
                    cloudMessage
                }.navigationTitle("LimeIoT") }
            }
        }.font(.system(size: 14))
    }
    @ViewBuilder private var cloudMessage: some View {
        if !cloud.message.isEmpty { Text(cloud.message).foregroundStyle(Palette.amber11).font(.system(size: 14)).accessibilityAddTraits(.updatesFrequently) }
    }
    private var cloudDevices: some View {
        List {
            cloudMessage
            if !cloud.online { Text("连接中断，当前显示上次观测").font(.system(size: 12)).foregroundStyle(Palette.amber11) }
            Section {
                Picker("空间", selection: Binding(get: { cloud.space }, set: { id in Task { await cloud.selectSpace(id) } })) {
                    ForEach(cloud.spaces) { Text($0.name).tag($0.id) }
                }.disabled(cloud.busy)
                if cloud.spaces.isEmpty { Text("暂无空间，请先在控制台创建。") }
                if let gateway = cloud.gateway { LabeledContent("网关", value: gateway.gatewayId).font(.system(size: 12)) }
                else if !cloud.space.isEmpty && cloud.online { Text("此空间尚未配对网关。") }
            }
            ForEach(cloud.devices) { device in
                Section(device.id) {
                    LabeledContent("连接", value: cloud.online && device.ready ? "在线" : "离线")
                    ForEach(cloud.models[device.modelRevision]?.services ?? [], id: \.id) { service in
                        ForEach(service.properties, id: \.id) { property in
                            CloudPropertyView(device: device, property: property, path: service.id + "." + property.id)
                        }
                        ForEach(service.actions ?? [], id: \.id) { action in
                            DeviceActionView(action: action, path: service.id + "." + action.id, disabled: !cloud.foreground || !cloud.online || cloud.busy || !device.ready || cloud.gateway?.scopes.contains("commands.write") != true || cloud.blocked(device)) { value in
                                Task { await cloud.control(device, path: service.id + "." + action.id, value: value, type: "action.invoke") }
                            }
                        }
                    }
                    ForEach(cloud.records.filter { $0.reference.request.deviceId == device.id && $0.rejection == nil && $0.result?.status.terminal != true }) { record in
                        Text(record.cloudStatus).font(.system(size: 12)).foregroundStyle(Palette.amber11)
                        Button("查询原操作") { Task { await cloud.resolve(record) } }.disabled(cloud.busy)
                    }
                }
            }
            if cloud.gateway != nil && cloud.devices.isEmpty && cloud.online { Text("暂无设备") }
            if cloud.hasMore { Button("加载更多") { Task { await cloud.loadMore() } }.disabled(cloud.busy) }
        }.refreshable { await cloud.refresh() }
    }
    private var cloudRecords: some View {
        List {
            cloudMessage
            ForEach(cloud.records.reversed()) { record in
                Section(record.reference.request.deviceId) {
                    LabeledContent("操作", value: record.reference.request.operation.summary)
                    LabeledContent("状态", value: record.cloudStatus)
                    if record.rejection != nil || record.result?.status.terminal == true {
                        Button("清理记录", role: .destructive) { Task { await cloud.forget(record) } }.disabled(cloud.busy)
                    } else { Button("查询原操作") { Task { await cloud.resolve(record) } }.disabled(cloud.busy) }
                }
            }
            if cloud.records.isEmpty { Text("当前空间暂无本机操作记录") }
        }
    }
}
private struct CloudPropertyView: View {
    @EnvironmentObject private var cloud: CloudStore
    let device: Device; let property: Property; let path: String
    @State private var number = ""
    private var disabled: Bool { !cloud.foreground || !cloud.online || cloud.busy || !device.ready || !property.access.contains("write") || cloud.gateway?.scopes.contains("commands.write") != true || cloud.blocked(device) }
    private var name: String { property.displayName }
    private var value: JSONValue? {
        guard let parsed = Double(number), parsed.isFinite, parsed >= (property.schema.minimum ?? -.infinity), parsed <= (property.schema.maximum ?? .infinity) else { return nil }
        if property.schema.type == "integer" { return Int(number).map(JSONValue.integer) }
        return .number(parsed)
    }
    var body: some View {
        if !property.access.contains("write") {
            LabeledContent(name) {
                VStack(alignment: .trailing) {
                    Text(property.displayValue(device.reported[path]?.value))
                    if device.reported[path]?.quality == "stale" { Text("已过期").font(.caption).foregroundStyle(Palette.sand11) }
                }
            }
        } else if property.schema.type == "boolean" {
            Toggle(name, isOn: Binding(get: { device.reported[path]?.value.bool ?? false }, set: { input in Task { await cloud.control(device, path: path, value: .bool(input)) } })).disabled(disabled || device.reported[path] == nil)
        } else if ["integer", "number"].contains(property.schema.type) {
            HStack {
                TextField(name, text: $number).keyboardType(.numbersAndPunctuation).disabled(disabled)
                Button("设置") { if let value { Task { await cloud.control(device, path: path, value: value) } } }.disabled(disabled || value == nil)
            }.task { if number.isEmpty { number = device.reported[path]?.value.text ?? "" } }
        } else { LabeledContent(name, value: device.reported[path]?.value.text ?? "暂无状态") }
    }
}
extension ControlCommandRecord {
    var cloudStatus: String {
        if rejection != nil { return "已拒绝" }
        switch result?.status ?? .unknown {
        case .unknown: return "结果待查询"
        case .accepted: return "已受理"
        case .dispatched: return "已发送，等待设备结果"
        case .confirmed:
            if reference.request.operation.type == "action.invoke", case .object(let receipt) = result?.localResult { return Command.actionStatus(receipt["evidence"]) }
            return reference.request.operation.type == "action.invoke" ? "完成范围未知" : "设备已完成"
        case .failed: return "设备执行失败"
        case .expired: return "已过期"
        case .rejected: return "已拒绝"
        }
    }
}
