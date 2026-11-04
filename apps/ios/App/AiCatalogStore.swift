import Foundation
import Combine
import LimeIoTKit

// 目录仅在当前前台页面保留；取消代次阻止已离页的响应重新开放入口。
@MainActor final class AiCatalogStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var online = true
    @Published private(set) var catalog: AiCatalog?
    @Published private(set) var message = ""
    private let load: () async throws -> AiCatalog
    private let authFailure: (Error) -> Void
    private var active = true
    private var generation = 0
    private var work: Task<Void, Never>?
    init(load: @escaping () async throws -> AiCatalog, authFailure: @escaping (Error) -> Void) { self.load = load; self.authFailure = authFailure }
    func refresh() {
        guard active, online, !busy else { return }
        let epoch = generation; busy = true; catalog = nil; message = ""
        work = Task {
            defer { if epoch == generation { busy = false; work = nil } }
            do {
                let next = try await load(); try Task.checkCancellation()
                guard active, epoch == generation, online else { return }; catalog = next
            } catch {
                guard active, epoch == generation, !(error is CancellationError) else { return }
                catalog = nil
                message = error is AiCatalogError || (error as? GatewayError) == .invalidResponse ? "AI 服务目录未通过校验，请刷新重试" : "无法读取 AI 服务，请检查网关连接"
                if (error as? GatewayError) == .unauthenticated { authFailure(error) }
            }
        }
    }
    func pause() { generation += 1; work?.cancel(); work = nil; busy = false; catalog = nil; message = "" }
    func setOnline(_ value: Bool) { if !value { pause() }; online = value }
    func close() { pause(); active = false }
    func waitForIdle() async { await work?.value }
}
