package run.limeai.iot.device

import kotlinx.serialization.json.*

/** 内置、固定摘要的逻辑模型；声明逻辑模型不授予本机额外执行能力。 */
enum class DeviceModelProfile(val id: String, val hasAudio: Boolean = false, val composedRemote: Boolean = false) {
    APPLICATIONS("android-tv-agent"),
    COMPOSED_REMOTE("android-tv-remote", composedRemote = true),
    AUDIO_APPLICATIONS("android-tv-audio-agent", hasAudio = true),
    AUDIO_COMPOSED_REMOTE("android-tv-audio-remote", hasAudio = true, composedRemote = true);

    val definition: JsonObject by lazy {
        val source = DeviceModelProfile::class.java.getResourceAsStream("/$id.json")
            ?.use { DeviceDocument.parse(it.readBytes()) } ?: throw DeviceFault("model_unavailable")
        // Rust规范投影省略空输出的properties/required；不按原始排版JSON计算模型修订。
        val services = source.getValue("services").jsonArray.map { rawService ->
            val service = rawService.obj()
            val actions = service.getValue("actions").jsonArray.map { rawAction ->
                val action = rawAction.obj(); val output = action.getValue("output").obj()
                val normalized = JsonObject(output.filterNot { (key, value) ->
                    key == "properties" && value == JsonObject(emptyMap()) || key == "required" && value == JsonArray(emptyList())
                })
                JsonObject(action + ("output" to normalized))
            }
            JsonObject(service + ("actions" to JsonArray(actions)))
        }
        JsonObject(source + ("services" to JsonArray(services)))
    }
    val revision: String by lazy { DeviceDocument.digest(definition) }
    val nativePaths: List<String> get() = if (hasAudio) listOf("apps.launch", "audio.set_volume", "audio.set_muted") else listOf("apps.launch")

    /** 明确批准的模型扩展可保留较小模型原记录；能力回退不能冒读新日志。 */
    fun acceptsHistory(previous: DeviceModelProfile): Boolean =
        (!previous.hasAudio || hasAudio) && (!previous.composedRemote || composedRemote)

    companion object {
        fun parse(id: String): DeviceModelProfile = values().singleOrNull { it.id == id }
            ?: throw DeviceFault("unsupported_model_profile")
    }
}

object TelevisionAgentModel {
    val definition: JsonObject get() = DeviceModelProfile.APPLICATIONS.definition
    val revision: String get() = DeviceModelProfile.APPLICATIONS.revision
}
