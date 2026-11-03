import Foundation

public struct MediaTarget: Sendable, Identifiable, Equatable {
    public let deviceId: String
    public let bindingRevision: String
    public let modelRevision: String
    public let target: String
    public let udn: String
    public var id: String { deviceId }
}

// 只读消费公开候选与当前执行绑定，不以兼容候选代替用户已经批准的绑定。
enum MediaTargets {
    private static func route(_ value: JSONValue?) throws {
        let v = try MediaJSON.fields(value, "adapter_id,revision"); try MediaJSON.id(v["adapter_id"]); try MediaJSON.hash(v["revision"])
    }
    private static func path(_ value: String) -> Bool { value.range(of: #"^[a-z][a-z0-9_-]{0,63}\.[a-z][a-z0-9_-]{0,63}$"#, options: .regularExpression) != nil }
    private static func paths(_ value: JSONValue?, allowEmpty: Bool = false) throws -> [String] {
        guard case .array(let items) = value, (allowEmpty || !items.isEmpty), items.count <= 64 else { throw MediaJSON.fail() }
        let names = try items.map(MediaJSON.text); try MediaJSON.require(names.allSatisfy(path) && names == names.sorted() && Set(names).count == names.count); return names
    }
    static func candidates(_ value: JSONValue) throws -> [JSONValue] {
        let page = try MediaJSON.fields(value, "items,next_cursor")
        guard case .array(let items) = page["items"], items.count <= 16, page["next_cursor"] == .null else { throw MediaJSON.fail() }
        var devices = Set<String>(), adapters = Set<String>(), result: [JSONValue] = []
        for item in items {
            let v = try MediaJSON.object(item)
            try MediaJSON.id(v["device_id"]); try route(v["route"]); let compatible = try MediaJSON.bool(v["compatible"])
            let target = try MediaJSON.text(v["target"]); try MediaJSON.require(!target.isEmpty && target.utf16.count <= 512)
            try MediaJSON.require(devices.insert(MediaJSON.text(v["device_id"])).inserted && adapters.insert(MediaJSON.string(v["route"]!, "adapter_id")).inserted)
            if v["kind"] == .string("dlna") {
                let managed = v["managed_media"] == .bool(true)
                _ = try MediaJSON.fields(item, managed ? "kind,device_id,route,compatible,target,udn,volume_limit,playback_volume,media,managed_media" : "kind,device_id,route,compatible,target,udn,volume_limit,playback_volume,media")
                try MediaJSON.require(MediaJSON.text(v["udn"]).range(of: #"^uuid:[A-Za-z0-9:_-]{1,123}$"#, options: .regularExpression) != nil)
                let limit = try MediaJSON.integer(v["volume_limit"], 1, 30); _ = try MediaJSON.integer(v["playback_volume"], 0, limit)
                guard case .array(let media) = v["media"], media.count <= 32 else { throw MediaJSON.fail() }
                var ids = Set<String>()
                for value in media {
                    let m = try MediaJSON.fields(value, "media_id,expires_at"); try MediaJSON.id(m["media_id"]); _ = try MediaJSON.time(m["expires_at"])
                    try MediaJSON.require(ids.insert(MediaJSON.text(m["media_id"])).inserted)
                }
                if managed && compatible { result.append(item) }
            } else {
                _ = try MediaJSON.fields(item, "device_id,route,compatible,target,fingerprint,device_serial,applications,paths")
                try MediaJSON.require(compatible == !paths(v["paths"], allowEmpty: true).isEmpty)
                for key in ["fingerprint", "device_serial"] { let s = try MediaJSON.text(v[key]); try MediaJSON.require(!s.isEmpty && s.utf16.count <= 512) }
                guard case .array(let applications) = v["applications"], applications.count <= 32 else { throw MediaJSON.fail() }
                for value in applications {
                    let a = try MediaJSON.fields(value, "application_id,category"), id = try MediaJSON.text(a["application_id"])
                    try MediaJSON.require(id.utf16.count <= 255 && ["leanback", "launcher"].contains(MediaJSON.text(a["category"])))
                }
            }
        }
        return result
    }
    static func current(_ value: JSONValue, candidate: JSONValue) throws -> MediaTarget? {
        let c = try MediaJSON.object(candidate), state = MediaJSON.string(value, "state")
        let v = try MediaJSON.fields(value, state == "composed" ? "device_id,model_revision,revision,state,routes,native_paths" : "device_id,model_revision,revision,state,routes")
        try MediaJSON.id(v["device_id"]); try MediaJSON.hash(v["model_revision"]); try MediaJSON.hash(v["revision"])
        try MediaJSON.require(v["device_id"] == c["device_id"] && ["native", "bound", "composed", "revoked"].contains(state))
        let routes = try MediaJSON.object(v["routes"]); try MediaJSON.require(routes.count <= 512 && (["bound", "composed"].contains(state) == !routes.isEmpty))
        for (key, value) in routes { try MediaJSON.require(path(key)); try route(value) }
        if state == "composed" { try MediaJSON.require(paths(v["native_paths"]).allSatisfy { routes[$0] == nil }) }
        guard routes["playback.play"] == c["route"] else { return nil }
        return MediaTarget(deviceId: try MediaJSON.text(v["device_id"]), bindingRevision: try MediaJSON.text(v["revision"]), modelRevision: try MediaJSON.text(v["model_revision"]), target: try MediaJSON.text(c["target"]), udn: try MediaJSON.text(c["udn"]))
    }
}
