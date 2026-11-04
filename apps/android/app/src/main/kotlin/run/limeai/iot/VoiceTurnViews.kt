package run.limeai.iot

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

@Composable fun VoiceTurnPanel(controller: VoiceTurnController, media: MediaController, online: Boolean) {
    val state by controller.state.collectAsStateWithLifecycle()
    val audio by media.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    LaunchedEffect(controller, lifecycle, online) {
        if (!online) { controller.pause(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { controller.refresh(); while (true) { delay(1000); controller.poll() } }
            finally { controller.pause() }
        }
    }
    DisposableEffect(controller) { onDispose { controller.pause() } }
    Text("语音对话", fontSize = 16.sp)
    if (state.message.isNotEmpty()) Text(state.message, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
    MediaPicker("录音", state.selectedMedia, audio.page?.items.orEmpty().filter { it.available }.map { it.id to it.id }, online && state.writable, controller::selectMedia)
    MediaPicker("声音", state.voice, state.capabilities?.speech?.voices.orEmpty().map { it to it }, online && state.writable, controller::selectVoice)
    Button(onClick = controller::start, enabled = online && state.canStart, modifier = Modifier.testTag("voice-turn-start")) { Text("开始语音对话") }
    Text(state.statusText, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    controller.visible()?.let { view ->
        view.transcript?.let { Text(it, fontSize = 14.sp) }; view.answer?.let { Text(it, fontSize = 14.sp) }
        view.mediaId?.let { id -> TextButton(onClick = { scope.launch { media.useGenerated(id) } }, enabled = online && state.writable && audio.writable) { Text("选作播放音频") } }
    }
    state.record?.let { record ->
        Text(record.id, fontSize = 12.sp)
        TextButton(onClick = controller::recover, enabled = online && state.writable) { Text("查询原回合") }
        TextButton(onClick = controller::continueTurn, enabled = online && state.canContinue) { Text("继续原回合") }
        TextButton(onClick = controller::requestStop, enabled = online && state.writable) { Text("停止回合") }
    }
    TextButton(onClick = controller::refresh, enabled = online && state.writable) { Text("读取语音服务") }
    if (state.confirmation) AlertDialog(onDismissRequest = controller::cancelStop, title = { Text("停止回合并清除生成的回答？") }, confirmButton = { TextButton(onClick = controller::confirmStop) { Text("停止回合") } }, dismissButton = { TextButton(onClick = controller::cancelStop) { Text("取消") } })
}
