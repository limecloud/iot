import Foundation
import Combine
import LimeIoTKit

@MainActor final class FirmwareStore: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var message = ""
    @Published private(set) var trusts: [FirmwareTrust] = []
    @Published private(set) var tasks: [OtaTask] = []
    @Published private(set) var records: [OtaRecord] = []
    @Published private(set) var reviewed: OtaTask?
    let space: String
    private let client: OtaClient
    private var active = true
    private let authFailure: (Error) -> Void
    init(client: OtaClient, space: String, authFailure: @escaping (Error) -> Void) { self.client = client; self.space = space; self.authFailure = authFailure }
    func close() { active = false; ready = false; reviewed = nil }
    private func read() async throws {
        let originals = try await client.records(space: space)
        guard active else { throw CancellationError() }; records = originals
        let nextTrusts = try await client.trusts(space: space), nextTasks = try await client.tasks(space: space)
        guard active else { throw CancellationError() }
        trusts = nextTrusts; tasks = nextTasks; ready = true
        if let reviewed, !nextTasks.contains(where: { $0.id == reviewed.id && $0.revision == reviewed.revision }) { self.reviewed = nil }
    }
    private func failure(_ error: Error) {
        guard active, !(error is CancellationError) else { return }
        ready = false; reviewed = nil
        message = (error as? OtaError)?.message ?? (error as? GatewayError)?.message ?? "结果未知，请查询升级原操作"
        if let error = error as? GatewayError, error == .unauthenticated { authFailure(error) }
    }
    func refresh() async {
        guard active, !busy else { return }; busy = true; defer { busy = false }
        do { try await read(); message = "" } catch { failure(error) }
    }
    func review(_ id: String) async {
        guard active, !busy, ready else { return }; busy = true; reviewed = nil; defer { busy = false }
        do { let current = try await client.task(space: space, id: id); guard active else { return }; reviewed = current; message = "" }
        catch { failure(error) }
    }
    func submit(_ change: () throws -> JSONValue) async {
        guard active, !busy, ready else { return }; busy = true; reviewed = nil; defer { busy = false }
        do {
            let result = try await client.submit(space: space, change: change())
            guard active else { return }; try await read(); message = result.statusText
        } catch {
            if let next = try? await client.records(space: space), active { records = next }
            failure(error)
        }
    }
    func transition(_ type: String) async {
        guard let reviewed else { return }
        await submit { try OtaChanges.transition(task: reviewed, type: type) }
    }
    func recover(_ key: String) async {
        guard active, !busy else { return }; busy = true; reviewed = nil; defer { busy = false }
        do { let result = try await client.resolve(space: space, key: key); guard active else { return }; try await read(); message = result.statusText }
        catch { failure(error) }
    }
}
