import SwiftUI
import LimeIoTKit

private extension AiCapability {
    var title: String { switch self { case .ruleDraft: "联动草案"; case .text: "文字对话"; case .vision: "图片观察"; case .transcription: "语音识别"; case .speech: "语音合成" } }
}
private let configurationLabels = ["concurrency": "并发任务", "max_output_tokens": "输出 Token 上限", "max_messages": "消息数上限", "max_context_bytes": "上下文字节上限", "max_instructions_characters": "指令字数上限", "max_text_bytes": "文字字节上限", "max_characters": "文字字数上限", "max_deadline_seconds": "期限上限（秒）", "max_retain_seconds": "保留上限（秒）", "streaming": "流式输出", "provider_cancellation": "提供方取消", "input_storage": "输入保存方式", "server_memory": "服务端记忆", "device_execution": "直接执行设备操作", "content_types": "图片格式", "max_image_bytes": "图片字节上限", "max_edge": "图片边长上限（像素）", "max_prompt_characters": "问题字数上限", "languages": "识别语言", "max_audio_bytes": "音频字节上限", "max_audio_seconds": "音频时长上限（秒）", "voices": "声音编号", "max_output_bytes": "输出字节上限"]
private func display(_ value: JSONValue) -> String {
    switch value { case .null: "未记录"; case .bool(let flag): flag ? "支持" : "不支持"; case .string(let text): text == "digest_only" ? "仅摘要" : text; case .array(let values): values.map(display).joined(separator: "、"); default: value.text }
}
struct AiCatalogView: View {
    @EnvironmentObject private var home: HomeStore
    @Environment(\.scenePhase) private var phase
    @StateObject private var services: AiCatalogStore
    @State private var visible = false
    @State private var destination: AiCapability?
    init(load: @escaping () async throws -> AiCatalog, authFailure: @escaping (Error) -> Void) { _services = StateObject(wrappedValue: AiCatalogStore(load: load, authFailure: authFailure)) }
    private func sync() {
        services.setOnline(home.online)
        if visible && phase == .active && home.online { services.refresh() } else { services.pause() }
    }
    var body: some View {
        List {
            Button("读取 AI 服务", action: services.refresh).disabled(!home.online || services.busy).accessibilityIdentifier("ai-catalog-refresh")
            if services.catalog == nil { Text(!home.online ? "网关离线，重新连接后可查询服务" : services.message.isEmpty ? "正在读取 AI 服务" : services.message).font(.footnote) }
            if let catalog = services.catalog {
                ForEach(catalog.entries) { entry in
                    Section(entry.capability.title) {
                        Text(entry.configured ? "已配置，健康未检测" : "未配置").font(.footnote).foregroundStyle(Palette.sand11)
                        if let model = entry.model { Text(model).textSelection(.enabled) }
                        if entry.configured { Button("打开" + entry.capability.title) { guard home.online, services.catalog != nil else { return }; destination = entry.capability }.disabled(!home.online || services.busy).accessibilityIdentifier("ai-catalog-open-" + entry.id) }
                        DisclosureGroup("能力详情") {
                            LabeledContent("能力编号", value: entry.id)
                            if case .object(let definition) = entry.definition {
                                ForEach(["create_operation", "resolve_operation", "input_schema", "task_schema"], id: \.self) { key in
                                    LabeledContent(["create_operation": "创建操作", "resolve_operation": "恢复操作", "input_schema": "输入合同", "task_schema": "任务合同"][key]!, value: definition[key] == .null ? "未提供机器 Schema" : display(definition[key] ?? .null))
                                }
                            }
                            LabeledContent("设备执行", value: "须独立审核与授权")
                            if entry.configured {
                                LabeledContent("部署修订", value: entry.revision ?? "未记录")
                                LabeledContent("数据位置", value: "本地")
                                if let config = entry.configuration { ForEach(config.keys.sorted(), id: \.self) { key in LabeledContent(configurationLabels[key] ?? key, value: display(config[key]!)) } }
                                LabeledContent("模型许可", value: "未核验"); LabeledContent("费用政策", value: "未登记")
                                LabeledContent("资源需求", value: "未登记"); LabeledContent("效果质量", value: "未核验")
                            }
                        }.font(.footnote)
                    }
                }
            }
        }.navigationTitle("AI 服务")
            .navigationDestination(item: $destination) { kind in
                switch kind {
                case .ruleDraft: AutomationView()
                case .text: if let conversation = home.textGeneration { TextGenerationView(conversation: conversation) }
                case .vision: if let vision = home.vision { VisionView(vision: vision) }
                case .transcription, .speech: if let media = home.media { MediaView(media: media, names: Dictionary(uniqueKeysWithValues: (home.snapshot?.devices ?? []).map { ($0.id, home.snapshot?.name($0) ?? $0.id) }), speech: home.speech, transcription: home.transcription, conversation: home.textGeneration, voiceTurn: home.voiceTurn) }
                }
            }
            .onAppear { visible = true; sync() }
            .onDisappear { visible = false; services.pause() }
            .onChange(of: phase) { _, _ in sync() }
            .onChange(of: home.online) { _, _ in sync() }
            .onChange(of: home.endpoint + "/" + (home.snapshot?.space ?? "")) { _, _ in services.pause(); sync() }
    }
}
