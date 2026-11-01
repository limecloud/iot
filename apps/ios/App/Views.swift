import SwiftUI
import LimeIoTKit

enum Palette {
    static let sand1 = Color(red: 253/255, green: 253/255, blue: 252/255)
    static let sand11 = Color(red: 113/255, green: 112/255, blue: 105/255)
    static let sand12 = Color(red: 33/255, green: 32/255, blue: 28/255)
    static let grass9 = Color(red: 70/255, green: 167/255, blue: 88/255)
    static let amber11 = Color(red: 171/255, green: 100/255, blue: 0)
}
struct RootView: View {
    @EnvironmentObject private var home: HomeStore
    @State private var token = ""
    var body: some View {
        Group {
            if home.connected {
                TabView {
                    NavigationStack { DevicesView() }.tabItem { Label("设备", systemImage: "house") }
                    NavigationStack { AutomationView() }.tabItem { Label("自动化", systemImage: "bolt") }
                    NavigationStack { ActivityView() }.tabItem { Label("执行记录", systemImage: "clock") }
                    NavigationStack { Form {
                        Section("家庭网关") { Text(home.endpoint).textSelection(.enabled); Text(home.online ? "本地已连接" : "连接中断") }
                        Button("退出登录", role: .destructive) { Task { await home.logout() } }.disabled(home.busy)
                        MessageView()
                    }.navigationTitle("设置") }.tabItem { Label("设置", systemImage: "gearshape") }
                }
            } else {
                NavigationStack { Form {
                    Section {
                        TextField("网关地址，例如 https://nas.local:8443", text: $home.endpoint).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("所有者凭据", text: $token).textContentType(.password)
                        Button(home.busy ? "正在连接" : "连接我的家") { let input = token; token = ""; Task { await home.connect(token: input) } }.disabled(home.busy || token.isEmpty)
                    }
                    MessageView()
                }.navigationTitle("LimeIoT") }
            }
        }.foregroundStyle(Palette.sand12)
    }
}
struct MessageView: View {
    @EnvironmentObject private var home: HomeStore
    var body: some View {
        if !home.message.isEmpty { Text(home.message).font(.footnote).foregroundStyle(Palette.amber11).accessibilityAddTraits(.updatesFrequently) }
        if home.connected && !home.online { Text("连接中断，当前显示上次观测").font(.footnote).foregroundStyle(Palette.amber11) }
    }
}
struct DevicesView: View {
    @EnvironmentObject private var home: HomeStore
    var body: some View {
        List {
            MessageView()
            if let snapshot = home.snapshot {
                ForEach(snapshot.devices) { device in
                    Section(snapshot.name(device)) {
                        LabeledContent("连接", value: home.online && device.ready ? "在线" : "离线")
                        ForEach(snapshot.models[device.modelRevision]?.services ?? [], id: \.id) { service in
                            ForEach(service.properties, id: \.id) { property in PropertyView(device: device, property: property, path: "\(service.id).\(property.id)") }
                        }
                        if home.pending[device.id] != nil { Button("查询原操作") { Task { await home.recover(device) } }.disabled(!home.online || home.busy) }
                        if let command = snapshot.commands.items.first(where: { $0.request.deviceId == device.id }) { LabeledContent("最近操作", value: command.statusText).font(.footnote) }
                        DisclosureGroup("设备详情") {
                            Text(device.id).textSelection(.enabled)
                            ForEach(device.reported.keys.sorted(), id: \.self) { path in
                                if let observation = device.reported[path] { VStack(alignment: .leading) { Text("\(path)：\(observation.value.text)"); Text("\(observation.quality == "stale" ? "已过期" : "有效") / \(observation.observedAt)"); Text("来源：\(observation.source)") }.font(.footnote) }
                            }
                        }
                    }
                }
            }
        }.navigationTitle("我的设备").refreshable { await home.refresh() }
    }
}
struct PropertyView: View {
    @EnvironmentObject private var home: HomeStore
    let device: Device; let property: Property; let path: String
    @State private var number = ""
    private var name: String { property.id == "power" ? "电源" : property.id == "brightness" ? "亮度" : property.id }
    private var disabled: Bool { !home.online || !device.ready || home.busy || home.pending[device.id] != nil || !property.access.contains("write") || home.snapshot?.commands.items.first(where: { $0.request.deviceId == device.id }).map { ["accepted", "dispatched"].contains($0.status) } == true }
    var body: some View {
        if property.schema.type == "boolean" {
            Toggle(name, isOn: Binding(get: { device.reported[path]?.value.bool ?? false }, set: { value in Task { await home.control(device, path: path, value: .bool(value)) } })).disabled(disabled || device.reported[path] == nil)
        } else if property.schema.type == "integer" {
            HStack {
                Text(name); TextField(name, text: $number).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                Button("设置") { if let value = Int(number) { Task { await home.control(device, path: path, value: .integer(value)) } } }.disabled(disabled || Int(number) == nil || Double(number).map { $0 < (property.schema.minimum ?? -.infinity) || $0 > (property.schema.maximum ?? .infinity) } != false)
            }.onChange(of: device.reported[path]?.value, initial: true) { _, next in number = next?.text ?? "0" }
        } else { LabeledContent(name, value: device.reported[path]?.value.text ?? "暂无状态") }
    }
}
private struct Source: Identifiable { let id: String; let device: String; let event: String; let name: String; let sample: JSONValue }
private struct Target: Identifiable { let id: String; let device: String; let path: String; let name: String }
struct AutomationView: View {
    @EnvironmentObject private var home: HomeStore
    @State private var sourceId = ""
    @State private var targetId = ""
    @State private var value = true
    @State private var cooldown = 10
    @State private var ruleId = "rule-" + UUID().uuidString.lowercased()
    @State private var reviewed: Rule?
    @State private var simulating = false
    private var sources: [Source] { home.snapshot?.devices.flatMap { device in home.snapshot?.models[device.modelRevision]?.services.flatMap { service in service.events.map { Source(id: device.id + "/" + service.id + "." + $0.id, device: device.id, event: service.id + "." + $0.id, name: (home.snapshot?.name(device) ?? device.id) + " " + ($0.id == "pressed" ? "按下时" : $0.id), sample: $0.schema.sample) } } ?? [] } ?? [] }
    private var targets: [Target] { home.snapshot?.devices.flatMap { device in home.snapshot?.models[device.modelRevision]?.services.flatMap { service in service.properties.filter { $0.schema.type == "boolean" && $0.access.contains("write") }.map { Target(id: device.id + "/" + service.id + "." + $0.id, device: device.id, path: service.id + "." + $0.id, name: (home.snapshot?.name(device) ?? device.id) + " " + ($0.id == "power" ? "电源" : $0.id)) } } ?? [] } ?? [] }
    private var source: Source? { sources.first { $0.id == sourceId } ?? sources.first }
    private var target: Target? { targets.first { $0.id == targetId } ?? targets.first }
    private var rule: Rule? { guard let source, let target else { return nil }; return Rule(id: ruleId, source: source.device, event: source.event, target: target.device, path: target.path, value: .bool(value), cooldownMs: cooldown * 1000) }
    var body: some View {
        Form {
            MessageView()
            DraftSection()
            if let rule, let source {
                Section("设置联动") {
                    Picker("当", selection: Binding(get: { source.id }, set: { sourceId = $0 })) { ForEach(sources) { Text($0.name).tag($0.id) } }
                    Picker("执行", selection: Binding(get: { target?.id ?? "" }, set: { targetId = $0 })) { ForEach(targets) { Text($0.name).tag($0.id) } }
                    Toggle("开启设备", isOn: $value)
                    Stepper("冷却 \(cooldown) 秒", value: $cooldown, in: 0...86400)
                    Button(simulating ? "正在预演" : "校验并预演") { simulating = true; reviewed = nil; Task { do { let result = try await home.simulate(rule, event: source.sample); if result.matched && !result.executed { reviewed = rule } } catch { home.report(error) }; simulating = false } }.disabled(!home.online || home.busy || simulating)
                    if reviewed == rule { Text("预演通过，设备尚未执行").font(.footnote).foregroundStyle(Palette.grass9) }
                    Button("启用自动化") { Task { await home.deploy(rule); reviewed = nil } }.disabled(!home.online || reviewed != rule || home.busy || simulating)
                }
            } else { Text("连接支持事件和控制的设备后，可以创建联动。") }
            Section("已启用") {
                ForEach(home.snapshot?.deployments ?? []) { deployment in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(sources.first { $0.device == deployment.rule.trigger.device && $0.event == deployment.rule.trigger.event }?.name ?? deployment.id)
                        Text("最近触发 \(deployment.lastRun ?? "尚无记录")").font(.footnote).foregroundStyle(Palette.sand11)
                        Button("停用") { Task { await home.stop(deployment) } }.disabled(!home.online || home.busy)
                    }
                }
                Button("新建自动化") { ruleId = "rule-" + UUID().uuidString.lowercased(); reviewed = nil }
            }
        }.navigationTitle("自动化").refreshable { await home.refresh() }
    }
}
struct DraftSection: View {
    @EnvironmentObject private var home: HomeStore
    private func name(_ id: String) -> String { home.snapshot?.devices.first { $0.id == id }.map { home.snapshot?.name($0) ?? id } ?? id }
    var body: some View {
        Section("用一句话设置") {
            if home.snapshot?.inference?.configured == true {
                TextField("希望如何联动", text: $home.draftPrompt, axis: .vertical).lineLimit(2...5).disabled(home.draftBusy || home.draft?.status == "running")
                Button("生成草案") { Task { await home.generateDraft() } }.disabled(!home.online || home.busy || home.draftBusy || home.draftPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (home.draftReference != nil && (home.draft == nil || home.draft?.status == "running")))
            } else { Text("请先在网关配置本地模型。生效后可生成联动草案。").font(.footnote).foregroundStyle(Palette.sand11) }
            if home.draftReference != nil {
                Button("查询生成结果") { Task { await home.recoverDraft() } }.disabled(!home.online || home.busy || home.draftBusy)
                if home.draft == nil || home.draft?.status != "running" { Button("新建草案") { Task { await home.newDraft() } }.disabled(home.busy || home.draftBusy) }
            }
            if let draft = home.draft {
                Text(draft.statusText).font(.footnote)
                if let error = draft.error { Text(GatewayError.server(error, 422).message).font(.footnote).foregroundStyle(Palette.amber11) }
                if draft.status == "completed", let rule = draft.rule, home.draftPrompt == draft.request.prompt {
                    Text("当\(name(rule.trigger.device))\(rule.trigger.event == "button.pressed" ? "按下时" : "发生 " + rule.trigger.event)：")
                    ForEach(rule.actions.indices, id: \.self) { index in
                        let action = rule.actions[index]
                        Text("\(name(action.device))\(action.set.path == "light.power" ? "电源" : action.set.path == "light.brightness" ? "亮度" : action.set.path)设为\(action.set.value.text)")
                    }
                    Text("冷却时间 \(rule.cooldownMs / 1000) 秒").font(.footnote).foregroundStyle(Palette.sand11)
                    Button("预演草案") { Task { await home.simulateDraft() } }.disabled(!home.online || home.busy || home.draftBusy)
                    Button("启用草案") { Task { await home.deployDraft() } }.disabled(!home.online || home.busy || home.draftBusy || home.draftProof == nil || home.draftProof != draft.ruleRevision)
                    DisclosureGroup("草案内容") { Text((try? String(data: JSONEncoder().encode(rule), encoding: .utf8)) ?? "").font(.footnote).textSelection(.enabled) }
                }
            }
            if !home.draftMessage.isEmpty { Text(home.draftMessage).font(.footnote).foregroundStyle(Palette.amber11) }
        }
    }
}
struct ActivityView: View {
    @EnvironmentObject private var home: HomeStore
    var body: some View {
        List {
            MessageView()
            Section("设备操作") {
                if home.snapshot?.commands.nextCursor != nil { Text("最近 100 条设备操作").font(.footnote).foregroundStyle(Palette.sand11) }
                ForEach(home.snapshot?.commands.items ?? []) { command in
                    DisclosureGroup {
                        Text(command.id).textSelection(.enabled).font(.footnote)
                        if let run = command.runId { LabeledContent("关联运行", value: run).font(.footnote) }
                        if let error = command.error { Text(error).font(.footnote) }
                    } label: { VStack(alignment: .leading) { Text("\(command.request.operation.path == "light.power" ? "电源" : "亮度") \(command.request.operation.value.text)"); Text(command.statusText).font(.footnote).foregroundStyle(command.status == "unknown" ? Palette.amber11 : Palette.sand11) } }
                }
            }
            Section("自动化运行") { ForEach(home.snapshot?.runs ?? []) { run in DisclosureGroup("\(run.commandIds.count) 个关联操作") { Text(run.id).textSelection(.enabled); ForEach(run.commandIds, id: \.self) { Text($0).textSelection(.enabled) } }.font(.footnote) } }
        }.navigationTitle("执行记录").refreshable { await home.refresh() }
    }
}
