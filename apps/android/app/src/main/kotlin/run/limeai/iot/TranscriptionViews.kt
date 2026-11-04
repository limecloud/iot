package run.limeai.iot

import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.*

@Composable fun TranscriptionPanel(controller: TranscriptionController, online: Boolean, conversation: TextGenerationController? = null) {
    val state by controller.state.collectAsStateWithLifecycle()
    val conversationState = conversation?.state?.collectAsStateWithLifecycle()?.value
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(controller, lifecycle, online) {
        if (!online) { controller.pause(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { controller.refresh(); while (true) { delay(1000); controller.poll() } }
            finally { controller.pause() }
        }
    }
    DisposableEffect(controller) { onDispose { controller.pause() } }
    Text("语音识别", fontSize = 16.sp)
    if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("transcription-message"))
    TextButton(onClick = controller::refresh, enabled = online && !state.busy) { Text("读取识别状态") }
    if (state.capabilities?.configured == false) Text("网关尚未配置本地识别服务", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (state.capabilities?.configured == true) {
        MediaPicker("音频", state.selectedMedia, listOf("" to "请选择已上传的音频") + state.sources.map { it.id to it.id }, online && state.writable && !state.pending, controller::selectMedia)
        MediaPicker("识别语言", state.language, listOf("auto" to "自动", "zh" to "中文", "en" to "英语"), online && state.writable && !state.pending, controller::selectLanguage)
        Button(onClick = controller::generate, enabled = online && state.canGenerate, modifier = Modifier.testTag("transcription-generate")) { Text("识别音频") }
    }
    state.records.asReversed().forEach { record ->
        key(record.key) {
            Text(record.statusText, fontSize = 14.sp)
            state.text(record.key)?.let { text -> SelectionContainer { Text(text.ifEmpty { "未识别到语音" }, fontSize = 14.sp, modifier = Modifier.testTag("transcription-result")) } }
            if (conversation != null && !state.text(record.key).isNullOrBlank()) TextButton(onClick = { controller.state.value.text(record.key)?.let(conversation::prepareQuestion) }, enabled = online && conversationState?.editable == true && conversationState.capabilities?.configured == true, modifier = Modifier.testTag("transcription-use-text")) { Text("带入新对话") }
            var expanded by remember { mutableStateOf(false) }
            TextButton(onClick = { expanded = !expanded }) { Text("任务详情") }
            if (expanded) Text(record.key, fontSize = 12.sp)
            if (record.rejectedCode == null) TextButton(onClick = { controller.recover(record.key) }, enabled = online && !state.busy) { Text("查询原任务") }
            if (record.status in listOf("running", "unknown")) TextButton(onClick = { controller.requestDiscard(record.key) }, enabled = online && state.writable) { Text("放弃输出") }
        }
    }
    if (state.confirmation != null) AlertDialog(onDismissRequest = controller::cancelDiscard, title = { Text("放弃此识别输出？") }, text = { Text("外部引擎可能继续计算。", fontSize = 14.sp) }, confirmButton = { TextButton(onClick = controller::confirmDiscard, enabled = online && state.writable) { Text("放弃输出") } }, dismissButton = { TextButton(onClick = controller::cancelDiscard) { Text("取消") } })
}
