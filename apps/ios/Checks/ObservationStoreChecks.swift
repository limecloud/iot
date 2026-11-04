import Foundation
import LimeIoTKit

@MainActor private final class Clock {
    var date = ISO8601DateFormatter().date(from: "2030-01-01T00:00:10Z")!
}
@MainActor private func fixture(_ memory: ObservationMemory, _ wire: ObservationWire, _ clock: Clock = Clock()) async throws -> ObservationStore {
    let store = ObservationStore(client: try await observationClient(memory, wire), space: "space-demo", authFailure: { _ in }, now: { clock.date })
    store.refresh(); await store.waitForIdle(); try observationCheck(store.ready, "initial state ready")
    store.setIEEE("1122334455667788"); store.setDevice("sensor"); return store
}
@main enum ObservationStoreChecks {
    @MainActor static func main() async throws {
        if ProcessInfo.processInfo.environment["LIMEIOT_OBSERVATION_LIVE"] == "1" { try await observationLiveChecks(); return }
        do {
            let wire = try ObservationWire(), store = try await fixture(ObservationMemory(), wire)
            store.query(); await store.waitForIdle(); let queriedPosts = await wire.posts; try observationCheck(store.canConfirm && queriedPosts == 0, "query only prepares")
            store.setEndpoint("2"); try observationCheck(store.review == nil, "input invalidates")
            store.setEndpoint("1"); store.query(); await store.waitForIdle(); store.confirm(); await store.waitForIdle()
            try observationCheck(store.records.count == 1 && store.bindings.first?.active == true, "explicit bind")
            let original = store.records[0].id
            store.reviewRevoke("sensor"); await store.waitForIdle(); let before = await wire.posts; try observationCheck(before == 1 && store.review?.candidate == nil, "revoke requires confirmation")
            store.confirm(); await store.waitForIdle(); try observationCheck(store.bindings.first?.active == false, "explicit revoke")
            store.recover(original); await store.waitForIdle(); try observationCheck(store.bindings.first?.active == false, "historical applied cannot restore revoked binding")
            let count = await wire.posts; try observationCheck(count == 2, "exactly two decisions")
        }
        do {
            let wire = try ObservationWire(), clock = Clock(), store = try await fixture(ObservationMemory(), wire, clock)
            store.query(); await store.waitForIdle(); clock.date.addTimeInterval(60); store.poll(); store.confirm()
            try observationCheck(store.review == nil && !store.canConfirm, "TTL invalidates")
            let count = await wire.posts; try observationCheck(count == 0, "expired review no POST")
        }
        do {
            let wire = try ObservationWire(), store = try await fixture(ObservationMemory(), wire)
            await wire.configure(queryHold: true); store.query()
            for _ in 0..<100 { if await wire.queryWaiting { break }; try await Task.sleep(for: .milliseconds(5)) }
            try observationCheck(await wire.queryWaiting, "query paused in wire")
            store.pause(); await wire.resumeQuery(); await store.waitForIdle()
            try observationCheck(store.review == nil && !store.ready && !store.busy, "late query cannot revive page")
            let count = await wire.posts; try observationCheck(count == 0, "paused query no decisions")
        }
        do {
            let memory = ObservationMemory(), wire = try ObservationWire(), store = try await fixture(memory, wire)
            store.query(); await store.waitForIdle(); await memory.configure(holding: true); store.confirm()
            for _ in 0..<100 { if await memory.waiting { break }; try await Task.sleep(for: .milliseconds(5)) }
            try observationCheck(await memory.waiting, "save waiting reached")
            store.pause(); await memory.resume(); await store.waitForIdle()
            let count = await wire.posts; try observationCheck(count == 0 && !store.ready && store.review == nil, "paused durable save prevents send")
            let restored = try await fixture(memory, wire); try observationCheck(restored.records.first?.pending == true, "prepared original survives restart")
        }
        do {
            let memory = ObservationMemory(), wire = try ObservationWire(), store = try await fixture(memory, wire)
            await wire.configure(drop: true); store.query(); await store.waitForIdle(); store.confirm(); await store.waitForIdle()
            try observationCheck(store.records.first?.pending == true && !store.ready, "loss preserves unknown")
            await wire.configure(); let restored = try await fixture(memory, wire)
            try observationCheck(restored.records.first?.pending == true, "refresh does not replay or hide unknown")
            restored.recover(restored.records[0].id); await restored.waitForIdle()
            let count = await wire.posts; try observationCheck(count == 1 && restored.records.first?.status == "applied", "recovery only GET")
        }
        do {
            let wire = try ObservationWire(), store = try await fixture(ObservationMemory(), wire), v = try observationFixture()
            store.query(); await store.waitForIdle(); await wire.setCurrent(v["revoked"]!); store.confirm(); await store.waitForIdle()
            let count = await wire.posts; try observationCheck(count == 0 && store.review == nil, "changed binding invalidates preflight")
        }
        do {
            let memory = ObservationMemory(), wire = try ObservationWire(), store = try await fixture(memory, wire)
            store.query(); await store.waitForIdle(); await memory.configure(fail: true); store.confirm(); await store.waitForIdle()
            let count = await wire.posts; try observationCheck(count == 0 && !store.ready, "storage failure no decisions")
            store.close(); store.setOnline(true); store.refresh(); store.query(); store.confirm(); try observationCheck(!store.ready && store.review == nil, "closed state cannot reopen")
        }
        do {
            let wire = try ObservationWire(), store = try await fixture(ObservationMemory(), wire)
            store.discover(); await store.waitForIdle(); try observationCheck(store.discovery?.items.count == 1 && store.review == nil, "discovery only observes")
            store.readEndpoints("1122334455667788"); await store.waitForIdle()
            try observationCheck(store.endpoints?.items.count == 2 && store.device == "sensor", "endpoints preserve custom device id")
            store.queryEndpoint(2); await store.waitForIdle(); try observationCheck(store.review == nil && store.endpoints != nil, "unsupported endpoint cannot query")
            store.queryEndpoint(1); await store.waitForIdle(); try observationCheck(store.canConfirm && store.discovery == nil && store.endpoints == nil, "supported endpoint uses original review")
            try observationCheck(await wire.posts == 0, "discovery chain still requires explicit confirmation")
            store.confirm(); await store.waitForIdle(); try observationCheck(await wire.posts == 1, "discovery chain explicit bind")
        }
        do {
            let wire = try ObservationWire(), clock = Clock(), store = try await fixture(ObservationMemory(), wire, clock)
            store.discover(); await store.waitForIdle(); store.readEndpoints("1122334455667788"); await store.waitForIdle()
            clock.date.addTimeInterval(60); store.poll(); store.queryEndpoint(1)
            try observationCheck(store.discovery == nil && store.endpoints == nil && store.review == nil, "expired discovery and endpoints do not auto retry")
            clock.date.addTimeInterval(-60); store.discover(); await store.waitForIdle(); store.setDevice("changed")
            try observationCheck(store.discovery == nil && store.endpoints == nil, "input invalidates discovered results")
            clock.date.addTimeInterval(-20); store.discover(); await store.waitForIdle()
            try observationCheck(store.discovery == nil && !store.ready, "future observation rejected")
        }
        for endpoints in [false, true] {
            let wire = try ObservationWire(), store = try await fixture(ObservationMemory(), wire)
            if endpoints { store.discover(); await store.waitForIdle() }
            await wire.configure(queryHold: true)
            if endpoints { store.readEndpoints("1122334455667788") } else { store.discover() }
            for _ in 0..<100 { if await wire.queryWaiting { break }; try await Task.sleep(for: .milliseconds(5)) }
            try observationCheck(await wire.queryWaiting, "probe waiting reached")
            store.setOnline(false); await wire.resumeQuery(); await store.waitForIdle()
            try observationCheck(store.discovery == nil && store.endpoints == nil && !store.ready, "late probe cannot revive offline page")
        }
        do {
            let wire = try ObservationWire(), store = try await fixture(ObservationMemory(), wire)
            await wire.configure(queryHold: true); store.discover()
            for _ in 0..<100 { if await wire.queryWaiting { break }; try await Task.sleep(for: .milliseconds(5)) }
            try observationCheck(await wire.queryWaiting, "probe waiting before context change")
            let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
            let device = try decoder.decode(Device.self, from: Data(#"{"device_id":"other","model_revision":"sha256:fixture","ready":false,"last_seen":null,"reported":{}}"#.utf8))
            store.updateDevices([device]); store.updateDevices([]); await wire.resumeQuery(); await store.waitForIdle()
            try observationCheck(store.discovery == nil && store.endpoints == nil, "context ABA cannot revive discovery")
        }
        print("{\"observation_state_groups\":12,\"hardware\":false,\"native_app_runtime\":false}")
    }
}
