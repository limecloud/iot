package run.limeai.iot.core

import kotlinx.serialization.json.*

enum class AiCapability(val id: String) {
    RULE_DRAFT("automation.rule_draft"), TEXT("text.generate"), VISION("vision.understand"), TRANSCRIPTION("audio.transcribe"), SPEECH("audio.synthesize")
}
class AiCatalogException : Exception("invalid_ai_catalog")
class AiCatalogEntry internal constructor(val capability: AiCapability, val definition: JsonObject, val deployment: JsonObject?) {
    val configured get() = deployment != null
    val model get() = deployment?.get("identity")?.jsonObject?.get("model")?.jsonPrimitive?.content
    val revision get() = deployment?.get("identity")?.jsonObject?.get("revision")?.takeUnless { it == JsonNull }?.jsonPrimitive?.content
    val configuration get() = deployment?.get("configuration")?.jsonObject
}
class AiCatalog internal constructor(val document: JsonObject, val entries: List<AiCatalogEntry>) {
    companion object {
        fun parse(raw: String, space: String): AiCatalog = try { AiCatalogJSON.checked(IntegerJSON.parse(raw, 32768, 8, 2048), space) }
        catch (_: Exception) { throw AiCatalogException() }
    }
}

internal object AiCatalogJSON {
    private fun definition(kind: AiCapability, inputs: List<String>, outputs: List<String>, schema: String, task: String?, operation: String) = buildJsonObject {
        put("capability_id", kind.id); put("input_modalities", JsonArray(inputs.map(::JsonPrimitive))); put("output_modalities", JsonArray(outputs.map(::JsonPrimitive)))
        put("input_schema", schema); put("task_schema", task?.let(::JsonPrimitive) ?: JsonNull)
        put("create_operation", "$operation.create"); put("resolve_operation", "$operation.resolve")
        put("streaming", false); put("tool_calling", false); put("structured_output", kind == AiCapability.RULE_DRAFT); put("device_execution", false)
    }
    private val definitions = JsonArray(listOf(
        definition(AiCapability.RULE_DRAFT, listOf("text", "device_context"), listOf("rule"), "draft-request", null, "drafts"),
        definition(AiCapability.TEXT, listOf("text"), listOf("text"), "text", "text#/$" + "defs/task", "text-generations"),
        definition(AiCapability.VISION, listOf("image", "text"), listOf("text"), "vision", "vision#/$" + "defs/task", "vision-observations"),
        definition(AiCapability.TRANSCRIPTION, listOf("audio"), listOf("text"), "transcription", "transcription#/$" + "defs/task", "audio-transcriptions"),
        definition(AiCapability.SPEECH, listOf("text"), listOf("audio"), "speech", "speech#/$" + "defs/task", "speech-syntheses")
    ))
    fun checked(value: JsonObject, space: String): AiCatalog = try {
        MediaJSON.require(space.matches(Regex("[A-Za-z0-9_-]{1,128}")))
        MediaJSON.fields(value, "schema_version,space_id,definitions,deployments,health,routing")
        MediaJSON.require(value["schema_version"] == JsonPrimitive(1) && value["space_id"] == JsonPrimitive(space) && value["definitions"] == definitions)
        MediaJSON.require(value["routing"] == buildJsonObject { put("selection", "fixed_configuration"); put("automatic_fallback", false) })
        val deployments = value["deployments"] as? JsonArray ?: throw AiCatalogException()
        val health = value["health"] as? JsonArray ?: throw AiCatalogException()
        MediaJSON.require(deployments.size <= 5 && health.size == 5)
        val deployed = mutableMapOf<AiCapability, JsonObject>()
        for (raw in deployments) {
            val item = MediaJSON.obj(raw); MediaJSON.fields(item, "capability_id,identity,configuration,license,cost_policy,resource_requirements,quality")
            val kind = AiCapability.entries.firstOrNull { JsonPrimitive(it.id) == item["capability_id"] } ?: throw AiCatalogException()
            MediaJSON.require(!deployed.containsKey(kind) && listOf("license", "cost_policy", "resource_requirements", "quality").all { item[it] == JsonNull })
            val config = MediaJSON.obj(item["configuration"])
            MediaJSON.require(listOf("configured", "capability", "deployment").none { it in config })
            val identity = MediaJSON.obj(item["identity"])
            val capability = JsonObject(config + mapOf("configured" to JsonPrimitive(true), "capability" to JsonPrimitive(kind.id), "deployment" to identity))
            when (kind) {
                AiCapability.TEXT -> TextGenerationJSON.capabilities(capability)
                AiCapability.VISION -> VisionJSON.capabilities(capability)
                AiCapability.TRANSCRIPTION -> TranscriptionJSON.capabilities(capability)
                AiCapability.SPEECH -> SpeechJSON.capabilities(capability)
                AiCapability.RULE_DRAFT -> {
                    MediaJSON.fields(identity, "adapter,revision,model,data_location")
                    MediaJSON.require(identity["adapter"] == JsonPrimitive("ollama") && identity["revision"] == JsonNull && identity["data_location"] == JsonPrimitive("local"))
                    MediaJSON.require(MediaJSON.text(identity, "model").matches(Regex("[A-Za-z0-9_:./-]{1,128}")))
                    MediaJSON.require(config == buildJsonObject { put("concurrency", 1); put("max_output_tokens", 1024) })
                }
            }
            deployed[kind] = item
        }
        val observed = mutableSetOf<AiCapability>()
        for (raw in health) {
            val item = MediaJSON.obj(raw); MediaJSON.fields(item, "capability_id,status,checked_at")
            val kind = AiCapability.entries.firstOrNull { JsonPrimitive(it.id) == item["capability_id"] } ?: throw AiCatalogException()
            MediaJSON.require(observed.add(kind) && item["checked_at"] == JsonNull && item["status"] == JsonPrimitive(if (kind in deployed) "unknown" else "not_configured"))
        }
        AiCatalog(value, AiCapability.entries.mapIndexed { i, kind -> AiCatalogEntry(kind, definitions[i].jsonObject, deployed[kind]) })
    } catch (_: Exception) { throw AiCatalogException() }
}
