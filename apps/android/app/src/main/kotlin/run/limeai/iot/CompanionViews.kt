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

@Composable fun CompanionPanel(controller: CompanionController, media: MediaController, online: Boolean) {
    val state by controller.state.collectAsStateWithLifecycle()
    val audio by media.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    LaunchedEffect(controller, lifecycle, online) {
        if (!online) { controller.pause(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { controller.refresh(); while (true) { delay(1000); controller.poll() } } finally { controller.pause() }
        }
    }
    DisposableEffect(controller) { onDispose { controller.pause() } }
    Text("陪伴", fontSize = 16.sp)
    if (state.message.isNotEmpty()) Text(state.message, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
    OutlinedTextField(value = state.instructions, onValueChange = controller::setInstructions, label = { Text("角色说明") }, minLines = 3, maxLines = 6, enabled = online && state.canEdit)
    MediaPicker("声音", state.voice, state.capabilities?.speech?.voices.orEmpty().map { it to it }, online && state.canEdit, controller::selectVoice)
    Text("每次会话最多 4 轮、10 分钟", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Button(onClick = controller::start, enabled = online && state.canStart, modifier = Modifier.testTag("companion-start")) { Text("开始陪伴") }
    Text(state.statusText, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (state.record != null) {
        MediaPicker("录音", state.selectedMedia, audio.page?.items.orEmpty().filter { it.available }.map { it.id to it.id }, online && state.writable, controller::selectMedia)
        Button(onClick = controller::reply, enabled = online && controller.canReply(), modifier = Modifier.testTag("companion-reply")) { Text("发送本轮录音") }
        controller.visible()?.let { view ->
            view.transcript?.let { Text(it, fontSize = 14.sp) }; view.answer?.let { Text(it, fontSize = 14.sp) }
            view.mediaId?.let { id -> TextButton(onClick = { scope.launch { media.useGenerated(id) } }, enabled = online && state.writable && audio.writable) { Text("选作播放音频") } }
        }
        TextButton(onClick = controller::recover, enabled = online && state.writable) { Text("查询原会话") }
        TextButton(onClick = controller::continueSession, enabled = online && controller.canContinue()) { Text("继续原回合") }
        TextButton(onClick = controller::requestStop, enabled = online && state.writable) { Text("停止会话") }
    }
    TextButton(onClick = controller::refresh, enabled = online && state.writable) { Text("读取陪伴状态") }
    if (state.confirmation) AlertDialog(onDismissRequest = controller::cancelStop, title = { Text("停止会话并清除生成的回答？") }, confirmButton = { TextButton(onClick = controller::confirmStop) { Text("停止会话") } }, dismissButton = { TextButton(onClick = controller::cancelStop) { Text("取消") } })
}
