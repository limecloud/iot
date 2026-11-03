package run.limeai.iot.device

import kotlinx.serialization.json.*
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/** 网络旅程的文件混音器；实际DeviceAgent消费此端口，不模拟MQTT报文或Android系统。 */
internal class FileAudioFixture(
    private val directory: Path,
    private val beforeEffect: (String, JsonObject) -> Unit,
) : AudioPort {
    private val source = directory.resolve("audio-system.json")
    private fun document() = DeviceDocument.parse(Files.readAllBytes(source), 4096)
    private fun state(value: JsonObject) = AudioState(value.integer("minimum").toInt(), value.integer("maximum").toInt(),
        value.integer("index").toInt(), value.getValue("muted").jsonPrimitive.boolean)
    override fun permitted(): Boolean = document().getValue("permitted").jsonPrimitive.boolean
    override fun read(): AudioState {
        val value = document()
        checkDevice(value.getValue("permitted").jsonPrimitive.boolean, "audio_not_authorized")
        return state(value)
    }
    override fun setVolume(percent: Int) {
        val value = document()
        apply(value, "audio.set_volume", obj("percent" to JsonPrimitive(percent)), "index", JsonPrimitive(state(value).indexFor(percent)))
    }
    override fun setMuted(muted: Boolean) {
        apply(document(), "audio.set_muted", obj("muted" to JsonPrimitive(muted)), "muted", JsonPrimitive(muted))
    }
    private fun apply(value: JsonObject, path: String, input: JsonObject, field: String, changed: JsonElement) {
        checkDevice(value.getValue("permitted").jsonPrimitive.boolean, "audio_not_authorized")
        beforeEffect(path, input)
        val next = directory.resolve("audio-system.next")
        Files.write(next, DeviceDocument.canonical(JsonObject(value + (field to changed))).toByteArray(Charsets.UTF_8))
        Files.move(next, source, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        if (value.getValue("unknown_after_effect").jsonPrimitive.boolean) error("fixture: audio effect started but outcome lost")
    }
}
