import Foundation

public struct ObservationNeighbor: Sendable, Equatable, Identifiable {
    public let document: JSONValue
    public var id: String { ObservationJSON.string(document, "ieee_address") }
    public var networkAddress: Int { ObservationJSON.number(document, "network_address") }
}
public struct ObservationDiscovery: Sendable, Equatable {
    public let document: JSONValue
    public var coordinatorIEEE: String { ObservationJSON.string(document, "coordinator_ieee") }
    public var observedAt: Date { try! ObservationJSON.time(ObservationJSON.map(document)["observed_at"]) }
    public var expiresAt: Date { try! ObservationJSON.time(ObservationJSON.map(document)["expires_at"]) }
    public var items: [ObservationNeighbor] {
        guard case .array(let items) = ObservationJSON.map(document)["items"] else { return [] }
        return items.map { ObservationNeighbor(document: $0) }
    }
}
public struct ObservationEndpoint: Sendable, Equatable, Identifiable {
    public let document: JSONValue
    public var id: Int { ObservationJSON.number(document, "endpoint") }
    public var supportsOnOff: Bool {
        guard ObservationJSON.number(document, "profile_id") == 0x0104, case .array(let clusters) = ObservationJSON.map(document)["input_clusters"] else { return false }
        return [0, 6].allSatisfy { clusters.contains(.integer($0)) }
    }
    public var supportsEnvironment: Bool {
        guard ObservationJSON.number(document, "profile_id") == 0x0104, case .array(let clusters) = ObservationJSON.map(document)["input_clusters"] else { return false }
        return [0, 0x0402, 0x0405].allSatisfy { clusters.contains(.integer($0)) }
    }
}
public struct ObservationEndpoints: Sendable, Equatable {
    public let document: JSONValue
    public var coordinatorIEEE: String { ObservationJSON.string(document, "coordinator_ieee") }
    public var ieee: String { ObservationJSON.string(document, "ieee_address") }
    public var observedAt: Date { try! ObservationJSON.time(ObservationJSON.map(document)["observed_at"]) }
    public var expiresAt: Date { try! ObservationJSON.time(ObservationJSON.map(document)["expires_at"]) }
    public var items: [ObservationEndpoint] {
        guard case .array(let items) = ObservationJSON.map(document)["endpoints"] else { return [] }
        return items.map { ObservationEndpoint(document: $0) }
    }
}

// 发现只是短期协议观测，不构造候选、绑定或本机耐久记录。
public enum ObservationDiscoveryJSON {
    public static func query(coordinator: String, ieee: String? = nil) throws -> JSONValue {
        try ObservationJSON.id(.string(coordinator)); var fields: [String: JSONValue] = ["coordinator_id": .string(coordinator)]
        if let ieee { try ObservationJSON.ieee(.string(ieee)); fields["ieee_address"] = .string(ieee) }
        return .object(fields)
    }
    private static func common(_ fields: [String: JSONValue], _ coordinator: ObservationCoordinator) throws {
        try ObservationJSON.id(fields["coordinator_id"]); try ObservationJSON.ieee(fields["coordinator_ieee"])
        let duration = try ObservationJSON.time(fields["expires_at"]).timeIntervalSince(ObservationJSON.time(fields["observed_at"]))
        try ObservationJSON.require(fields["coordinator_id"] == .string(coordinator.id) && fields["coordinator_ieee"] == .string(coordinator.ieee)
            && fields["protocol"] == .string("zigbee-znp") && fields["evidence"] == .string("unauthenticated_protocol") && duration > 0 && duration <= 60)
    }
    public static func discovery(_ value: JSONValue, coordinator: ObservationCoordinator) throws -> ObservationDiscovery {
        let d = try ObservationJSON.fields(value, "coordinator_id,coordinator_ieee,observed_at,expires_at,protocol,evidence,scope,items")
        try common(d, coordinator); try ObservationJSON.require(d["scope"] == .string("coordinator_neighbors"))
        guard case .array(let items) = d["items"], items.count <= 64 else { throw ObservationJSON.fail() }
        var identities = Set<String>(), addresses = Set<Int>()
        for item in items {
            let n = try ObservationJSON.fields(item, "extended_pan_id,ieee_address,network_address,device_type,rx_on_when_idle,relationship,flags,permit_joining,depth,link_quality")
            try ObservationJSON.require(ObservationJSON.matches(try ObservationJSON.text(n["extended_pan_id"]), "[a-f0-9]{16}"))
            try ObservationJSON.ieee(n["ieee_address"]); try ObservationJSON.integer(n["network_address"], 1...0xfff7); try ObservationJSON.integer(n["flags"], 0...255)
            let flags = ObservationJSON.number(item, "flags"), ieee = try ObservationJSON.text(n["ieee_address"]), address = ObservationJSON.number(item, "network_address")
            try ObservationJSON.require(ieee != coordinator.ieee && identities.insert(ieee).inserted && addresses.insert(address).inserted
                && n["device_type"] == .integer(flags & 3) && n["rx_on_when_idle"] == .integer((flags >> 2) & 3) && n["relationship"] == .integer((flags >> 4) & 7))
            for key in ["permit_joining", "depth", "link_quality"] { try ObservationJSON.integer(n[key], 0...255) }
        }
        return ObservationDiscovery(document: value)
    }
    public static func endpoints(_ value: JSONValue, coordinator: ObservationCoordinator, ieee: String) throws -> ObservationEndpoints {
        let d = try ObservationJSON.fields(value, "coordinator_id,coordinator_ieee,observed_at,expires_at,protocol,evidence,ieee_address,network_address,manufacturer_code,endpoints")
        try common(d, coordinator); try ObservationJSON.ieee(d["ieee_address"])
        try ObservationJSON.require(d["ieee_address"] == .string(ieee) && ieee != coordinator.ieee)
        try ObservationJSON.integer(d["network_address"], 1...0xfff7); try ObservationJSON.integer(d["manufacturer_code"], 0...65535)
        guard case .array(let items) = d["endpoints"], items.count <= 16 else { throw ObservationJSON.fail() }
        var ids = Set<Int>()
        for item in items {
            let e = try ObservationJSON.fields(item, "endpoint,profile_id,device_id,device_version,input_clusters,output_clusters")
            try ObservationJSON.integer(e["endpoint"], 1...240); try ObservationJSON.require(ids.insert(ObservationJSON.number(item, "endpoint")).inserted)
            for key in ["profile_id", "device_id"] { try ObservationJSON.integer(e[key], 0...65535) }
            try ObservationJSON.integer(e["device_version"], 0...15)
            for key in ["input_clusters", "output_clusters"] {
                guard case .array(let clusters) = e[key], clusters.count <= 32 else { throw ObservationJSON.fail() }
                var seen = Set<Int>()
                for cluster in clusters {
                    try ObservationJSON.integer(cluster, 0...65535)
                    guard case .integer(let number) = cluster, seen.insert(number).inserted else { throw ObservationJSON.fail() }
                }
            }
        }
        return ObservationEndpoints(document: value)
    }
}
