package run.limeai.iot.core

import kotlinx.serialization.json.*

class MediaTarget internal constructor(val deviceId: String, val bindingRevision: String, val modelRevision: String, val target: String, val udn: String)

// 只读消费公开候选与当前执行绑定，不以兼容候选代替用户已经批准的绑定。
internal object MediaTargets {
    private fun route(value: JsonElement?) {
        val v = MediaJSON.obj(value); MediaJSON.fields(v, "adapter_id,revision"); MediaJSON.id(v["adapter_id"]); MediaJSON.hash(v["revision"])
    }
    private fun path(value: String) = value.matches(Regex("[a-z][a-z0-9_-]{0,63}\\.[a-z][a-z0-9_-]{0,63}"))
    private fun paths(value: JsonElement?, allowEmpty: Boolean = false): List<String> {
        val array = value as? JsonArray ?: throw MediaException("invalid_media_document")
        val names = array.map(MediaJSON::str)
        MediaJSON.require((allowEmpty || names.isNotEmpty()) && names.size <= 64 && names.all(::path) && names == names.sorted() && names.distinct().size == names.size); return names
    }
    fun candidates(page: JsonObject): List<JsonObject> {
        MediaJSON.fields(page, "items,next_cursor"); val items = page["items"] as? JsonArray ?: throw MediaException("invalid_media_document")
        MediaJSON.require(page["next_cursor"] == JsonNull && items.size <= 16)
        val devices = mutableSetOf<String>(); val adapters = mutableSetOf<String>(); val result = mutableListOf<JsonObject>()
        for (item in items) {
            val v = MediaJSON.obj(item); MediaJSON.id(v["device_id"]); route(v["route"]); val compatible = MediaJSON.bool(v["compatible"])
            MediaJSON.require(MediaJSON.text(v, "target").length in 1..512)
            MediaJSON.require(devices.add(MediaJSON.text(v, "device_id")) && adapters.add(MediaJSON.text(MediaJSON.obj(v["route"]), "adapter_id")))
            if (v["kind"] == JsonPrimitive("dlna")) {
                val managed = v["managed_media"] == JsonPrimitive(true)
                MediaJSON.fields(v, if (managed) "kind,device_id,route,compatible,target,udn,volume_limit,playback_volume,media,managed_media" else "kind,device_id,route,compatible,target,udn,volume_limit,playback_volume,media")
                MediaJSON.require(MediaJSON.text(v, "udn").matches(Regex("uuid:[A-Za-z0-9:_-]{1,123}")))
                val limit = MediaJSON.integer(v["volume_limit"], 1, 30); MediaJSON.integer(v["playback_volume"], 0, limit)
                val media = v["media"] as? JsonArray ?: throw MediaException("invalid_media_document"); MediaJSON.require(media.size <= 32); val ids = mutableSetOf<String>()
                for (value in media) {
                    val m = MediaJSON.obj(value); MediaJSON.fields(m, "media_id,expires_at"); MediaJSON.id(m["media_id"]); MediaJSON.time(m["expires_at"]); MediaJSON.require(ids.add(MediaJSON.text(m, "media_id")))
                }
                if (managed && compatible) result += v
            } else {
                MediaJSON.fields(v, "device_id,route,compatible,target,fingerprint,device_serial,applications,paths")
                MediaJSON.require(compatible == paths(v["paths"], allowEmpty = true).isNotEmpty())
                for (key in listOf("fingerprint", "device_serial")) MediaJSON.require(MediaJSON.text(v, key).length in 1..512)
                val applications = v["applications"] as? JsonArray ?: throw MediaException("invalid_media_document"); MediaJSON.require(applications.size <= 32)
                for (value in applications) {
                    val a = MediaJSON.obj(value); MediaJSON.fields(a, "application_id,category")
                    MediaJSON.require(MediaJSON.text(a, "application_id").length <= 255 && MediaJSON.text(a, "category") in listOf("leanback", "launcher"))
                }
            }
        }
        return result
    }
    fun current(v: JsonObject, candidate: JsonObject): MediaTarget? {
        val state = MediaJSON.text(v, "state")
        MediaJSON.fields(v, if (state == "composed") "device_id,model_revision,revision,state,routes,native_paths" else "device_id,model_revision,revision,state,routes")
        MediaJSON.id(v["device_id"]); MediaJSON.hash(v["model_revision"]); MediaJSON.hash(v["revision"])
        MediaJSON.require(v["device_id"] == candidate["device_id"] && state in listOf("native", "bound", "composed", "revoked"))
        val routes = MediaJSON.obj(v["routes"]); MediaJSON.require(routes.size <= 512 && ((state in listOf("bound", "composed")) == routes.isNotEmpty()))
        for ((key, value) in routes) { MediaJSON.require(path(key)); route(value) }
        if (state == "composed") MediaJSON.require(paths(v["native_paths"]).none { it in routes })
        if (routes["playback.play"] != candidate["route"]) return null
        return MediaTarget(MediaJSON.text(v, "device_id"), MediaJSON.text(v, "revision"), MediaJSON.text(v, "model_revision"), MediaJSON.text(candidate, "target"), MediaJSON.text(candidate, "udn"))
    }
}
