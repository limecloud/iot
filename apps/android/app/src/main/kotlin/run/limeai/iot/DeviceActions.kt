package run.limeai.iot

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.serialization.json.*
import run.limeai.iot.core.ModelAction
import run.limeai.iot.core.Operation

@Composable fun DeviceActions(action: ModelAction, path: String, disabled: Boolean, onInvoke: (JsonElement) -> Unit) {
    var input by remember(path) { mutableStateOf(if (path == "apps.launch") "" else action.input.sample().toString()) }
    var error by remember(path) { mutableStateOf("") }
    val keys = action.input.properties["key"]?.enumValues?.mapNotNull { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content }.orEmpty()
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when {
            path == "remote.press" && keys.isNotEmpty() && keys.all { it in Operation.keyLabels } -> {
                Text("遥控器", fontSize = 16.sp)
                listOf("menu", "up", "home", "left", "select", "right", "back", "down", "play_pause").chunked(3).forEach { row ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { key ->
                            if (key in keys) OutlinedButton(onClick = { onInvoke(buildJsonObject { put("key", key) }) }, enabled = !disabled, modifier = Modifier.weight(1f).heightIn(min = 48.dp), contentPadding = PaddingValues(4.dp)) { Text(Operation.keyLabels.getValue(key), fontSize = 14.sp) }
                            else Spacer(Modifier.weight(1f).height(48.dp))
                        }
                    }
                }
            }
            path == "apps.launch" -> {
                OutlinedTextField(input, { input = it }, label = { Text("应用 ID") }, enabled = !disabled, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button(onClick = { onInvoke(buildJsonObject { put("application_id", input) }) }, enabled = !disabled && input.isNotBlank() && input.codePointCount(0, input.length) <= 255) { Text("启动应用") }
            }
            else -> {
                Text(action.id, fontSize = 16.sp)
                OutlinedTextField(input, { input = it; error = "" }, label = { Text("动作参数（JSON）") }, enabled = !disabled, modifier = Modifier.fillMaxWidth())
                Button(onClick = {
                    val value = runCatching { Json.parseToJsonElement(input) }.getOrNull()
                    if (value == null) error = "请输入有效的动作参数" else { error = ""; onInvoke(value) }
                }, enabled = !disabled) { Text("执行动作") }
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, fontSize = 14.sp)
            }
        }
    }
}
