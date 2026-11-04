package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.time.Instant

@ConsistentCopyVisibility
data class ObservationNeighbor internal constructor(val document: JsonObject) {
    val ieee get() = ObservationJSON.text(document, "ieee_address")
    val networkAddress get() = document.getValue("network_address").jsonPrimitive.int
}
@ConsistentCopyVisibility
data class ObservationDiscovery internal constructor(val document: JsonObject) {
    val coordinatorIEEE get() = ObservationJSON.text(document, "coordinator_ieee")
    val observedAt: Instant get() = ObservationJSON.time(document["observed_at"])
    val expiresAt: Instant get() = ObservationJSON.time(document["expires_at"])
    val items get() = document.getValue("items").jsonArray.map { ObservationNeighbor(it.jsonObject) }
}
@ConsistentCopyVisibility
data class ObservationEndpoint internal constructor(val document: JsonObject) {
    val endpoint get() = document.getValue("endpoint").jsonPrimitive.int
    val supportsEnvironment get() = document["profile_id"] == JsonPrimitive(0x0104) && listOf(0, 0x0402, 0x0405).all { JsonPrimitive(it) in document.getValue("input_clusters").jsonArray }
    val supportsOnOff get() = document["profile_id"] == JsonPrimitive(0x0104) && listOf(0, 6).all { JsonPrimitive(it) in document.getValue("input_clusters").jsonArray }
}
@ConsistentCopyVisibility
data class ObservationEndpoints internal constructor(val document: JsonObject) {
    val coordinatorIEEE get() = ObservationJSON.text(document, "coordinator_ieee")
    val ieee get() = ObservationJSON.text(document, "ieee_address")
    val observedAt: Instant get() = ObservationJSON.time(document["observed_at"])
    val expiresAt: Instant get() = ObservationJSON.time(document["expires_at"])
    val items get() = document.getValue("endpoints").jsonArray.map { ObservationEndpoint(it.jsonObject) }
}

// 发现只是短期协议观测，不构造候选、绑定或本机耐久记录。
object ObservationDiscoveryJSON {
    fun query(coordinator: String, ieee: String? = null): JsonObject = with(ObservationJSON) {
        id(JsonPrimitive(coordinator)); if (ieee != null) ieee(JsonPrimitive(ieee))
        buildJsonObject { put("coordinator_id", coordinator); if (ieee != null) put("ieee_address", ieee) }
    }
    private fun common(d: JsonObject, coordinator: ObservationCoordinator) = with(ObservationJSON) {
        id(d["coordinator_id"]); ieee(d["coordinator_ieee"])
        val observed = time(d["observed_at"]); val expires = time(d["expires_at"])
        require(d["coordinator_id"] == JsonPrimitive(coordinator.id) && d["coordinator_ieee"] == JsonPrimitive(coordinator.ieee)
            && d["protocol"] == JsonPrimitive("zigbee-znp") && d["evidence"] == JsonPrimitive("unauthenticated_protocol") && expires.isAfter(observed) && !expires.isAfter(observed.plusSeconds(60)))
    }
    fun discovery(value: JsonObject, coordinator: ObservationCoordinator): ObservationDiscovery = with(ObservationJSON) {
        val d = fields(value, "coordinator_id,coordinator_ieee,observed_at,expires_at,protocol,evidence,scope,items")
        common(d, coordinator); require(d["scope"] == JsonPrimitive("coordinator_neighbors"))
        val items = d["items"] as? JsonArray ?: fail(); require(items.size <= 64)
        val identities = mutableSetOf<String>(); val addresses = mutableSetOf<Int>()
        for (item in items) {
            val n = fields(item, "extended_pan_id,ieee_address,network_address,device_type,rx_on_when_idle,relationship,flags,permit_joining,depth,link_quality")
            require(text(n["extended_pan_id"]).matches(Regex("[a-f0-9]{16}")))
            ieee(n["ieee_address"]); integer(n["network_address"], 1L..0xfff7L); integer(n["flags"], 0L..255L)
            val flags = n.getValue("flags").jsonPrimitive.int; val identity = text(n["ieee_address"])
            require(identity != coordinator.ieee && identities.add(identity) && addresses.add(n.getValue("network_address").jsonPrimitive.int)
                && n["device_type"] == JsonPrimitive(flags and 3) && n["rx_on_when_idle"] == JsonPrimitive((flags shr 2) and 3) && n["relationship"] == JsonPrimitive((flags shr 4) and 7))
            for (key in listOf("permit_joining", "depth", "link_quality")) integer(n[key], 0L..255L)
        }
        ObservationDiscovery(value)
    }
    fun endpoints(value: JsonObject, coordinator: ObservationCoordinator, target: String): ObservationEndpoints = with(ObservationJSON) {
        val d = fields(value, "coordinator_id,coordinator_ieee,observed_at,expires_at,protocol,evidence,ieee_address,network_address,manufacturer_code,endpoints")
        common(d, coordinator); ieee(d["ieee_address"]); require(d["ieee_address"] == JsonPrimitive(target) && target != coordinator.ieee)
        integer(d["network_address"], 1L..0xfff7L); integer(d["manufacturer_code"], 0L..65535L)
        val items = d["endpoints"] as? JsonArray ?: fail(); require(items.size <= 16); val ids = mutableSetOf<Int>()
        for (item in items) {
            val e = fields(item, "endpoint,profile_id,device_id,device_version,input_clusters,output_clusters")
            integer(e["endpoint"], 1L..240L); require(ids.add(e.getValue("endpoint").jsonPrimitive.int))
            for (key in listOf("profile_id", "device_id")) integer(e[key], 0L..65535L)
            integer(e["device_version"], 0L..15L)
            for (key in listOf("input_clusters", "output_clusters")) {
                val clusters = e[key] as? JsonArray ?: fail(); require(clusters.size <= 32); val seen = mutableSetOf<Int>()
                for (cluster in clusters) { integer(cluster, 0L..65535L); require(seen.add(cluster.jsonPrimitive.int)) }
            }
        }
        ObservationEndpoints(value)
    }
}
