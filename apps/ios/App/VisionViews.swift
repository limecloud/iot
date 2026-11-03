import SwiftUI
import UniformTypeIdentifiers
import LimeIoTKit

struct VisionView: View {
    @ObservedObject var vision: VisionStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var picker = false
    @State private var reading = false
    @State private var fileGeneration = 0
    @State private var fileWork: Task<Void, Never>?
    private func stopReading() { fileGeneration += 1; fileWork?.cancel(); fileWork = nil; reading = false }
    private func readFile(_ result: Result<[URL], Error>) {
        guard scenePhase == .active, vision.online else { return }
        stopReading(); reading = true; let epoch = fileGeneration
        fileWork = Task { @MainActor in
            defer { if epoch == fileGeneration { reading = false; fileWork = nil } }
            do {
                let urls = try result.get(); guard let url = urls.first, urls.count == 1 else { return }
                let file = try await MediaFile.read(url, maxBytes: VisionRequests.maxImageBytes)
                await vision.waitForIdle(); try Task.checkCancellation()
                guard epoch == fileGeneration, scenePhase == .active else { return }
                vision.selectFile(file.name, bytes: file.data)
            } catch {
                guard epoch == fileGeneration, !(error is CancellationError), scenePhase == .active else { return }
                await vision.waitForIdle()
                guard !Task.isCancelled, epoch == fileGeneration else { return }; vision.fileFailure(error)
            }
        }
    }
    var body: some View {
        Form {
            Section {
                if !vision.message.isEmpty { Text(vision.message).font(.footnote).foregroundStyle(Palette.amber11).accessibilityIdentifier("vision-message") }
                Button("读取观察状态") { vision.refresh() }.disabled(vision.busy || !vision.online || reading)
                if vision.capabilities?.configured == false { Text("网关尚未配置本地视觉服务").font(.footnote).foregroundStyle(Palette.sand11) }
                if vision.capabilities?.configured == true {
                    Button(reading ? "正在读取图片" : "选择图片") { picker = true }.disabled(!vision.editable || reading).accessibilityIdentifier("vision-select")
                    if !vision.fileName.isEmpty { Text(vision.fileName).font(.footnote).privacySensitive() }
                    Text("PNG或JPEG，最多2 MiB，边长不超过1024像素").font(.footnote).foregroundStyle(Palette.sand11)
                    TextField("问题，最多512字", text: Binding(get: { vision.prompt }, set: vision.setPrompt), axis: .vertical).lineLimit(3...6).privacySensitive().disabled(!vision.editable || reading).accessibilityIdentifier("vision-prompt")
                    Button("分析图片", action: vision.generate).disabled(!vision.canGenerate || reading).accessibilityIdentifier("vision-generate")
                }
            }
            if !vision.records.isEmpty {
                Section("观察记录") {
                    ForEach(vision.records.reversed()) { record in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(record.statusText).font(.body)
                            if let text = vision.text(for: record.id) { Text(text).font(.body).textSelection(.enabled).privacySensitive().accessibilityIdentifier("vision-result") }
                            DisclosureGroup("任务详情") { Text(record.id).font(.footnote).textSelection(.enabled) }
                            if record.rejectedCode == nil { Button("查询原任务") { vision.recover(record.id) }.disabled(vision.busy || !vision.online || reading) }
                            if record.canDiscard { Button(record.status == "succeeded" ? "清除观察结果" : "放弃输出", role: .destructive) { vision.requestDiscard(record.id) }.disabled(!vision.writable || reading) }
                        }
                    }
                }
            }
        }.navigationTitle("图片观察")
            .fileImporter(isPresented: $picker, allowedContentTypes: [.png, .jpeg], allowsMultipleSelection: false, onCompletion: readFile)
            .confirmationDialog(vision.clearingSuccess ? "清除此观察结果？" : "放弃此观察输出？", isPresented: Binding(get: { vision.confirmation != nil }, set: { if !$0 { vision.cancelDiscard() } }), titleVisibility: .visible) {
                Button(vision.clearingSuccess ? "清除观察结果" : "放弃输出", role: .destructive, action: vision.confirmDiscard).disabled(!vision.writable)
                Button("取消", role: .cancel, action: vision.cancelDiscard)
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { stopReading(); vision.pause(); return }
                vision.refresh()
                while !Task.isCancelled { do { try await Task.sleep(for: .seconds(1)) } catch { break }; vision.poll() }
            }
            .onChange(of: vision.online) { _, online in if online { vision.refresh() } else { stopReading() } }
            .onDisappear { stopReading(); vision.pause() }
    }
}
