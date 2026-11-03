package run.limeai.iot

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.*
import kotlinx.serialization.json.jsonPrimitive

@Composable fun SpeechPanel(controller: SpeechController, online: Boolean) {
    val state by controller.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(controller, lifecycle, online) {
        if (!online) { controller.pause(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { controller.refresh(); while (true) { delay(1000); controller.poll() } }
            finally { controller.pause() }
        }
    }
    DisposableEffect(controller) { onDispose { controller.pause() } }
    Text("文字转语音", fontSize = 16.sp)
    if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("speech-message"))
    TextButton(onClick = controller::refresh, enabled = online && !state.busy) { Text("读取语音状态") }
    if (state.capabilities?.configured == false) Text("网关尚未配置本地语音服务", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (state.capabilities?.configured == true) {
        Text("文本", fontSize = 14.sp)
        BasicTextField(value = state.text, onValueChange = controller::setText, enabled = online && state.writable && !state.pending, minLines = 3, maxLines = 6, keyboardOptions = KeyboardOptions(autoCorrectEnabled = false), textStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface), modifier = Modifier.fillMaxWidth().border(0.5.dp, MaterialTheme.colorScheme.outline).padding(12.dp).semantics { contentDescription = "文本" }.testTag("speech-text"))
        Text("${state.text.codePointCount(0, state.text.length)} / 1000", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        MediaPicker("声音", state.voice, state.capabilities?.voices.orEmpty().map { it to it }, online && state.writable && !state.pending && state.capabilities?.voices?.size != 1, controller::selectVoice)
        MediaPicker("保留时间", state.retainSeconds.toString(), listOf("600" to "10 分钟", "3600" to "1 小时", "86400" to "24 小时"), online && state.writable && !state.pending) { controller.setRetention(it.toInt()) }
        Button(onClick = controller::generate, enabled = online && state.canGenerate, modifier = Modifier.testTag("speech-generate")) { Text("生成音频") }
    }
    state.records.asReversed().forEach { record ->
        key(record.key) {
            Text(record.statusText, fontSize = 14.sp)
            Text("${record.original["input_characters"]!!.jsonPrimitive.content} 字，${record.original["voice"]!!.jsonPrimitive.content}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            var expanded by remember { mutableStateOf(false) }
            TextButton(onClick = { expanded = !expanded }) { Text("任务详情") }
            if (expanded) { Text(record.key, fontSize = 12.sp); record.mediaId?.let { Text(it, fontSize = 12.sp) } }
            if (record.rejectedCode == null) TextButton(onClick = { controller.recover(record.key) }, enabled = online && !state.busy) { Text("查询原任务") }
            if (record.status in listOf("running", "unknown")) TextButton(onClick = { controller.requestDiscard(record.key) }, enabled = online && state.writable) { Text("放弃输出") }
        }
    }
    if (state.confirmation != null) AlertDialog(onDismissRequest = controller::cancelDiscard, title = { Text("放弃此音频输出？") }, text = { Text("外部引擎可能继续计算。", fontSize = 14.sp) }, confirmButton = { TextButton(onClick = controller::confirmDiscard, enabled = online && state.writable) { Text("放弃输出") } }, dismissButton = { TextButton(onClick = controller::cancelDiscard) { Text("取消") } })
}
