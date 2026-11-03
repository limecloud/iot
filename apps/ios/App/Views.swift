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
    @EnvironmentObject private var cloud: CloudStore
    @AppStorage("connection.mode") private var connection = "nas"
    @State private var token = ""
    var body: some View {
        VStack(spacing: 0) {
            if !home.connected && cloud.principal == nil && !cloud.pendingAuthorization {
                Picker("连接方式", selection: $connection) { Text("家庭网关").tag("nas"); Text("云服务").tag("cloud") }
                    .pickerStyle(.segmented).padding().disabled(home.busy || cloud.busy)
            }
            if connection == "cloud" { CloudRootView() }
            else if home.connected {
                TabView {
                    NavigationStack { DevicesView() }.tabItem { Label("设备", systemImage: "house") }
                    NavigationStack { AutomationView() }.tabItem { Label("自动化", systemImage: "bolt") }
                    NavigationStack { ActivityView() }.tabItem { Label("执行记录", systemImage: "clock") }
                    NavigationStack { Form {
                        Section("家庭网关") { Text(home.endpoint).textSelection(.enabled); Text(home.online ? "本地已连接" : "连接中断") }
                        if let firmware = home.firmware { NavigationLink("固件升级") { FirmwareView(firmware: firmware, devices: home.snapshot?.devices ?? []) } }
                        if let media = home.media { MediaSettingsLinks(media: media) }
                        else { Button("退出登录", role: .destructive) { Task { await home.logout() } }.disabled(home.busy || home.firmware?.busy == true) }
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
                            ForEach(service.actions ?? [], id: \.id) { action in
                                DeviceActionView(action: action, path: service.id + "." + action.id, disabled: !home.online || !device.ready || home.busy || home.pending[device.id] != nil) { value in
                                    Task { await home.control(device, path: service.id + "." + action.id, value: value, type: "action.invoke") }
                                }
                            }
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
    private var name: String { property.displayName }
    private var disabled: Bool { !home.online || !device.ready || home.busy || home.pending[device.id] != nil || !property.access.contains("write") || home.snapshot?.commands.items.first(where: { $0.request.deviceId == device.id }).map { ["accepted", "dispatched"].contains($0.status) } == true }
    var body: some View {
        if !property.access.contains("write") {
            LabeledContent(name) {
                VStack(alignment: .trailing) {
                    Text(property.displayValue(device.reported[path]?.value))
                    if device.reported[path]?.quality == "stale" { Text("已过期").font(.caption).foregroundStyle(Palette.sand11) }
                }
            }
        } else if property.schema.type == "boolean" {
            Toggle(name, isOn: Binding(get: { device.reported[path]?.value.bool ?? false }, set: { value in Task { await home.control(device, path: path, value: .bool(value)) } })).disabled(disabled || device.reported[path] == nil)
        } else if property.schema.type == "integer" {
            HStack {
                Text(name); TextField(name, text: $number).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                Button("设置") { if let value = Int(number) { Task { await home.control(device, path: path, value: .integer(value)) } } }.disabled(disabled || Int(number) == nil || Double(number).map { $0 < (property.schema.minimum ?? -.infinity) || $0 > (property.schema.maximum ?? .infinity) } != false)
            }.onChange(of: device.reported[path]?.value, initial: true) { _, next in number = next?.text ?? "0" }
        } else { LabeledContent(name, value: device.reported[path]?.value.text ?? "暂无状态") }
    }
}
struct DeviceActionView: View {
    let action: ModelAction; let path: String; let disabled: Bool; let invoke: (JSONValue) -> Void
    @State private var input = ""
    @State private var error = ""
    private var keys: [String] { action.input.properties?["key"]?.enumValues?.compactMap { if case .string(let key) = $0 { key } else { nil } } ?? [] }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if path == "remote.press", !keys.isEmpty, keys.allSatisfy({ Operation.keyLabels[$0] != nil }) {
                Text("遥控器")
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 12) {
                    ForEach(["menu", "up", "home", "left", "select", "right", "back", "down", "play_pause"], id: \.self) { key in
                        if keys.contains(key) { Button(Operation.keyLabels[key]!) { invoke(.object(["key": .string(key)])) }.frame(maxWidth: .infinity, minHeight: 44).buttonStyle(.bordered) }
                        else { Color.clear.frame(height: 44).accessibilityHidden(true) }
                    }
                }
            } else if path == "apps.launch" {
                TextField("应用 ID", text: $input).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("启动应用") { invoke(.object(["application_id": .string(input)])) }.disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || input.unicodeScalars.count > 255)
            } else {
                Text(action.id)
                TextField("动作参数（JSON）", text: $input, axis: .vertical).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("执行动作") {
                    do { invoke(try JSONDecoder().decode(JSONValue.self, from: Data(input.utf8))); error = "" }
                    catch { error = "请输入有效的动作参数" }
                }
                if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(Palette.amber11) }
            }
        }.disabled(disabled).onAppear { if input.isEmpty && path != "apps.launch" { input = action.input.sample.jsonText } }
    }
}
private struct Source: Identifiable {
    let id: String; let device: String; let event: String; let name: String; let sample: JSONValue; var property: Property? = nil
    func matches(_ trigger: Rule.Trigger) -> Bool {
        device == trigger.device && (property == nil ? event == trigger.event : event == trigger.property?.path && property?.unit == trigger.property?.unit)
    }
}
private struct Target: Identifiable { let id: String; let device: String; let path: String; let name: String; let type: String; let sample: JSONValue; let schema: ValueSchema }
struct AutomationView: View {
    @EnvironmentObject private var home: HomeStore
    @State private var sourceId = ""
    @State private var scheduled = false
    @State private var scheduleTime = "22:00"
    @State private var timeZone = TimeZone.current.identifier
    @State private var weekdays = [1, 2, 3, 4, 5, 6, 7]
    @State private var targetId = ""
    @State private var value = true
    @State private var actionInput: String?
    @State private var cooldown = "10"
    @State private var conditions: [ConditionForm] = []
    @State private var preview: Simulation?
    @State private var editing = false
    @State private var threshold = "28"
    @State private var hysteresis = "1"
    @State private var edge: Rule.PropertyTrigger.Edge = .rising
    @State private var ruleId = "rule-" + UUID().uuidString.lowercased()
    @State private var reviewed: Rule?
    @State private var simulating = false
    private var sources: [Source] {
        let items: [Source] = home.snapshot?.devices.flatMap { device in
            home.snapshot?.models[device.modelRevision]?.services.flatMap { service in
                let name = home.snapshot?.name(device) ?? device.id
                let events = service.events.map { Source(id: device.id + "/" + service.id + "." + $0.id, device: device.id, event: service.id + "." + $0.id, name: name + " " + ($0.id == "pressed" ? "按下时" : $0.id), sample: $0.schema.sample) }
                let properties = service.properties.filter { ["integer", "number"].contains($0.schema.type) && $0.access.contains("read") && $0.access.contains("notify") && $0.unit != nil }.map { property in
                    let path = service.id + "." + property.id
                    return Source(id: device.id + "/property/" + path, device: device.id, event: path, name: name + " " + property.displayName, sample: .null, property: property)
                }
                return events + properties
            } ?? []
        } ?? []
        return items.sorted { $0.property == nil && $1.property != nil }
    }
    private var targets: [Target] {
        home.snapshot?.devices.flatMap { device in
            home.snapshot?.models[device.modelRevision]?.services.flatMap { service in
                let name = home.snapshot?.name(device) ?? device.id
                let properties = service.properties.filter { ["boolean", "integer", "number"].contains($0.schema.type) && $0.access.contains("write") }.map { property in
                    let path = service.id + "." + property.id
                    return Target(id: device.id + "/set/" + path, device: device.id, path: path, name: name + " " + property.displayName, type: "property.set", sample: property.schema.sample, schema: property.schema)
                }
                let actions = (service.actions ?? []).map { action in
                    let path = service.id + "." + action.id
                    return Target(id: device.id + "/invoke/" + path, device: device.id, path: path, name: name + " " + path, type: "action.invoke", sample: action.input.sample, schema: action.input)
                }
                return properties + actions
            } ?? []
        } ?? []
    }
    private var source: Source? { sourceId.isEmpty ? sources.first : sources.first { $0.id == sourceId } }
    private var target: Target? { targetId.isEmpty ? targets.first : targets.first { $0.id == targetId } }
    private var conditionSources: [ConditionSource] { ConditionEditor.sources(home.snapshot) }
    private var rule: Rule? {
        guard let target, let compiled = ConditionEditor.compile(conditions, sources: conditionSources), let cooldownMs = ConditionEditor.cooldown(cooldown) else { return nil }
        let input: JSONValue
        if target.type == "action.invoke" {
            guard let parsed = try? JSONDecoder().decode(JSONValue.self, from: Data((actionInput ?? target.sample.jsonText).utf8)) else { return nil }
            input = parsed
        } else if target.schema.type == "boolean" { input = .bool(value) }
        else { guard let parsed = ThresholdEditor.number(actionInput ?? target.sample.jsonText, schema: target.schema) else { return nil }; input = parsed }
        let trigger: Rule.Trigger
        if scheduled {
            guard let schedule = Rule.Trigger.Schedule.fromForm(time: scheduleTime, timeZone: timeZone, weekdays: weekdays) else { return nil }
            trigger = Rule.Trigger(schedule: schedule)
        } else if let source, let property = source.property {
            guard let result = ThresholdEditor.property(path: source.event, unit: property.unit!, schema: property.schema, edge: edge, threshold: threshold, hysteresis: hysteresis), ThresholdEditor.samples(result, schema: property.schema) != nil else { return nil }
            trigger = Rule.Trigger(device: source.device, property: result)
        } else if let source { trigger = Rule.Trigger(device: source.device, event: source.event) }
        else { return nil }
        return Rule(id: ruleId, trigger: trigger, target: target.device, path: target.path, value: input, cooldownMs: cooldownMs, type: target.type, conditions: compiled)
    }
    private var eventSample: JSONValue? {
        if scheduled { return .null }
        guard let source else { return nil }
        if let property = source.property { guard let trigger = rule?.trigger.property else { return nil }; return ThresholdEditor.samples(trigger, schema: property.schema) }
        return source.sample
    }
    private func reset() { ruleId = "rule-" + UUID().uuidString.lowercased(); sourceId = ""; scheduled = false; scheduleTime = "22:00"; timeZone = TimeZone.current.identifier; weekdays = [1,2,3,4,5,6,7]; targetId = ""; value = true; actionInput = nil; cooldown = "10"; conditions = []; threshold = "28"; hysteresis = "1"; edge = .rising; reviewed = nil; preview = nil; editing = false }
    var body: some View {
        Form {
            MessageView()
            DraftSection()
            if let target {
                Section("设置联动") {
                    Picker("触发方式", selection: $scheduled) { Text("设备事件或属性").tag(false); Text("定时").tag(true) }
                    if scheduled {
                        TextField("时间（HH:MM）", text: $scheduleTime).keyboardType(.numbersAndPunctuation)
                        TextField("IANA 时区", text: $timeZone).autocorrectionDisabled().textInputAutocapitalization(.never)
                        DisclosureGroup("重复") { ForEach(1...7, id: \.self) { day in Toggle(["周一","周二","周三","周四","周五","周六","周日"][day - 1], isOn: Binding(get: { weekdays.contains(day) }, set: { selected in if selected { weekdays.append(day) } else { weekdays.removeAll { $0 == day } } })) } }
                    } else if let source {
                        Picker("当", selection: Binding(get: { source.id }, set: { sourceId = $0 })) { ForEach(sources) { Text($0.name).tag($0.id) } }
                    }
                    if !scheduled, let property = source?.property {
                        Picker("变化方向", selection: $edge) { Text("上升越过").tag(Rule.PropertyTrigger.Edge.rising); Text("下降越过").tag(Rule.PropertyTrigger.Edge.falling) }
                        TextField("阈值（\(ThresholdEditor.label(property.unit!))）", text: $threshold).keyboardType(.numbersAndPunctuation)
                        TextField("滞回（\(ThresholdEditor.label(property.unit!))）", text: $hysteresis).keyboardType(.decimalPad)
                    }
                    Picker("执行", selection: Binding(get: { target.id }, set: { targetId = $0; actionInput = nil })) { ForEach(targets) { Text($0.name).tag($0.id) } }
                    if target.type == "action.invoke" { TextField("动作参数（JSON）", text: Binding(get: { actionInput ?? target.sample.jsonText }, set: { actionInput = $0 }), axis: .vertical).lineLimit(2...5).autocorrectionDisabled() }
                    else if target.schema.type == "boolean" { Toggle("开启设备", isOn: $value) }
                    else { TextField("设为", text: Binding(get: { actionInput ?? target.sample.jsonText }, set: { actionInput = $0 })).keyboardType(.numbersAndPunctuation) }
                    TextField("冷却时间（秒）", text: $cooldown).keyboardType(.decimalPad)
                    DisclosureGroup("仅当") { ConditionFormsView(forms: $conditions, sources: conditionSources, total: ConditionEditor.count(conditions)).disabled(home.busy || simulating) }
                    if ConditionEditor.compile(conditions, sources: conditionSources) == nil { Text("请检查条件值、组合层级和数量。每组最多16项，共32项，最多4层。").font(.footnote).foregroundStyle(Palette.amber11) }
                    Button(simulating ? "正在预演" : "校验并预演") { guard let rule, let eventSample else { return }; simulating = true; reviewed = nil; preview = nil; Task { do { let result = try await home.simulate(rule, event: eventSample); if result.canDeploy { reviewed = rule; preview = result } } catch { home.report(error) }; simulating = false } }.disabled(!home.online || home.busy || simulating || rule == nil)
                    if !scheduled && source?.property != nil { Text("预演使用示例采样，不控制设备。").font(.footnote).foregroundStyle(Palette.sand11) }
                    if let rule, reviewed == rule, let preview { Text(preview.matched ? "预演通过，设备尚未执行" : "触发样例有效，当前条件未满足。启用后等待新的触发，不会补执行。").font(.footnote).foregroundStyle(Palette.grass9); if let evidence = preview.conditionEvaluation { ConditionEvidenceView(evaluation: evidence) } }
                    Button("启用自动化") { guard let rule else { return }; Task { await home.deploy(rule); reviewed = nil } }.disabled(!home.online || rule == nil || reviewed != rule || home.busy || simulating)
                    if editing { Button("取消编辑", action: reset).disabled(home.busy || simulating) }
                }
            } else { Text("连接支持控制的设备后，可以创建联动。") }
            Section("已启用") {
                ForEach(home.snapshot?.deployments ?? []) { deployment in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(deployment.rule.trigger.schedule?.summary ?? deployment.rule.trigger.property?.summary ?? sources.first { $0.matches(deployment.rule.trigger) }?.name ?? deployment.id)
                        ForEach(deployment.rule.actions.indices, id: \.self) { index in Text(deployment.rule.actions[index].device + " " + deployment.rule.actions[index].operation.summary).font(.footnote) }
                        if !deployment.rule.conditions.isEmpty { DisclosureGroup("条件：全部满足") { ForEach(Array(ConditionEditor.rows(deployment.rule.conditions).enumerated()), id: \.offset) { Text($0.element).font(.footnote) } } }
                        Text("最近触发 \(deployment.lastRun ?? "尚无记录")").font(.footnote).foregroundStyle(Palette.sand11)
                        if deployment.rule.version == 1, deployment.rule.actions.count == 1, let forms = ConditionEditor.restore(deployment.rule.conditions, sources: conditionSources),
                           let first = deployment.rule.actions.first,
                           let editable = targets.first(where: { $0.device == first.device && $0.path == first.operation.path && $0.type == first.operation.type }),
                           deployment.rule.trigger.schedule != nil || sources.contains(where: { $0.matches(deployment.rule.trigger) }) {
                            Button("编辑") { ruleId = deployment.rule.id; sourceId = sources.first(where: { $0.matches(deployment.rule.trigger) })?.id ?? ""; scheduled = deployment.rule.trigger.schedule != nil; if let schedule = deployment.rule.trigger.schedule { scheduleTime = schedule.time; timeZone = schedule.timeZone; weekdays = schedule.weekdays }; targetId = editable.id; value = first.operation.value == .bool(true); actionInput = first.operation.value.jsonText; cooldown = ConditionEditor.cooldownText(deployment.rule.cooldownMs); conditions = forms; editing = true; if let property = deployment.rule.trigger.property { edge = property.edge; threshold = ThresholdEditor.display(property.threshold, unit: property.unit); hysteresis = ThresholdEditor.display(property.hysteresis, unit: property.unit) }; reviewed = nil; preview = nil }.disabled(home.busy || simulating)
                        }
                        Button("停用") { Task { await home.stop(deployment) } }.disabled(!home.online || home.busy)
                    }
                }
                Button("新建自动化", action: reset).disabled(home.busy || simulating)
            }
        }.navigationTitle("自动化").refreshable { await home.refresh() }.onChange(of: conditions) { _, _ in reviewed = nil; preview = nil }
    }
}
private struct ConditionFormsView: View {
    @Binding var forms: [ConditionForm]
    let sources: [ConditionSource]
    let total: Int
    var depth = 1
    var prefix = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach($forms) { $node in
                let number = prefix + String((forms.firstIndex { $0.id == node.id } ?? 0) + 1)
                VStack(alignment: .leading, spacing: 8) {
                    Text("条件 " + number).font(.footnote)
                    if node.kind == "compare" {
                        Picker("属性", selection: Binding(get: { node.source }, set: { selected in if let source = sources.first(where: { $0.id == selected }) { let id = node.id; node = ConditionForm(source: source); node.id = id } })) { ForEach(sources) { Text($0.name).tag($0.id) } }
                        if let source = sources.first(where: { $0.id == node.source }) {
                            Picker("比较", selection: $node.comparison) { ForEach(ConditionEditor.operators(source.schema), id: \.self) { Text(ConditionEditor.label($0)).tag($0) } }
                            if source.schema.type == "boolean" { Picker("比较值", selection: $node.value) { Text("是").tag("true"); Text("否").tag("false") } }
                            else { TextField("比较值" + (source.unit.map { "（" + ThresholdEditor.label($0) + "）" } ?? ""), text: $node.value).autocorrectionDisabled().textInputAutocapitalization(.never) }
                        }
                    } else {
                        Picker("组合方式", selection: $node.kind) { Text("全部满足").tag("all"); Text("任一满足").tag("any") }
                        AnyView(ConditionFormsView(forms: $node.children, sources: sources, total: total, depth: depth + 1, prefix: number + "-")).padding(.leading, 12)
                    }
                    Button("移除条件 " + number) { let id = node.id; forms.removeAll { $0.id == id } }.font(.footnote)
                }
                Divider()
            }
            Menu("添加条件") {
                ForEach(["compare", "all", "any"], id: \.self) { kind in Button(kind == "compare" ? "属性比较" : kind == "all" ? "全部满足组" : "任一满足组") { if let source = sources.first { var form = ConditionForm(source: source); form.kind = kind; if kind != "compare" { form.children = [ConditionForm(source: source)] }; forms.append(form) } }.disabled(sources.isEmpty || forms.count >= 16 || total + (kind == "compare" ? 1 : 2) > 32 || kind != "compare" && depth >= 4) }
            }
        }
    }
}
private struct ConditionEvidenceView: View {
    let evaluation: JSONValue
    private var matched: Bool { if case .object(let fields) = evaluation { fields["matched"] == .bool(true) } else { false } }
    var body: some View {
        DisclosureGroup("条件判断：" + (matched ? "已满足" : "未满足")) {
            ForEach(Array(ConditionEditor.evidenceRows(evaluation).enumerated()), id: \.offset) { Text($0.element).font(.footnote).textSelection(.enabled) }
            DisclosureGroup("原始条件证据") { Text(evaluation.jsonText).font(.footnote).textSelection(.enabled) }
        }
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
                    Text("当\(name(rule.trigger.device))\(rule.trigger.summary)：")
                    ForEach(rule.actions.indices, id: \.self) { index in
                        let action = rule.actions[index]
                        Text(name(action.device) + " " + action.operation.summary)
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
                    } label: { VStack(alignment: .leading) { Text(command.request.operation.summary); Text(command.statusText).font(.footnote).foregroundStyle(command.status == "unknown" ? Palette.amber11 : Palette.sand11) } }
                }
            }
            Section("自动化运行") { ForEach(home.snapshot?.runs ?? []) { run in DisclosureGroup(run.error == "automation_budget_exceeded" ? "自动化操作过于频繁，本次未执行" : run.error == "rule_conditions_not_met" ? "条件未满足，本次未执行" : run.error == nil ? "\(run.commandIds.count) 个关联操作" : "运行未完成") { Text(run.id).textSelection(.enabled); if let error = run.error { Text(error) }; ForEach(run.commandIds, id: \.self) { Text($0).textSelection(.enabled) }; if let evaluation = run.conditionEvaluation { ConditionEvidenceView(evaluation: evaluation) } }.font(.footnote) } }
        }.navigationTitle("执行记录").refreshable { await home.refresh() }
    }
}
