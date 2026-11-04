package run.limeai.iot

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay

@Composable fun TextGenerationPanel(controller: TextGenerationController, enabled: Boolean, speech: SpeechController? = null) {
    val state by controller.state.collectAsState()
    val speechState = speech?.state?.collectAsState()?.value
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(controller, lifecycle, enabled) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) controller.pause()
            else if (event == Lifecycle.Event.ON_START && enabled) controller.refresh()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); controller.pause() }
    }
    LaunchedEffect(controller, enabled) { if (enabled && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) controller.refresh() }
    LaunchedEffect(controller) { while (true) { delay(1000); if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) controller.poll() } }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
        TextButton(onClick = controller::refresh, enabled = enabled && !state.busy) { Text("读取对话状态") }
        if (state.capabilities?.configured == false) Text("网关尚未配置本地文字模型", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.capabilities?.configured == true) {
            OutlinedTextField(value = state.prompt, onValueChange = controller::setPrompt, label = { Text("消息") }, minLines = 3, enabled = enabled && state.editable, modifier = Modifier.fillMaxWidth().testTag("text-prompt"))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = controller::generate, enabled = enabled && state.canGenerate, modifier = Modifier.testTag("text-generate")) { Text("发送") }
                TextButton(onClick = controller::startNew, enabled = enabled && state.editable) { Text("开始新对话") }
            }
            if (state.messages.size >= 15) Text("本轮上下文已满，请开始新对话", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        state.messages.forEach { item -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { Text(if (item.role == "user") "你" else "助手", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(item.content, fontSize = 16.sp) } }
        state.records.asReversed().forEach { record ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(record.statusText, fontSize = 16.sp)
                if (state.messages.isEmpty()) state.text(record.key)?.let { Text(it, fontSize = 16.sp, modifier = Modifier.testTag("text-result")) }
                if (speech != null && state.text(record.key) != null) TextButton(onClick = { controller.state.value.text(record.key)?.let(speech::prepareAnswer) }, enabled = enabled && speechState?.writable == true && !speechState.pending && speechState.capabilities?.configured == true, modifier = Modifier.testTag("text-use-speech")) { Text("带入语音合成") }
                var details by remember(record.key) { mutableStateOf(false) }
                TextButton(onClick = { details = !details }) { Text("任务详情") }; if (details) Text(record.key, fontSize = 12.sp)
                if (record.rejectedCode == null) TextButton(onClick = { controller.recover(record.key) }, enabled = enabled && !state.busy) { Text("查询原任务") }
                if (record.canDiscard) TextButton(onClick = { controller.requestDiscard(record.key) }, enabled = enabled && state.writable) { Text(if (record.status == "succeeded") "清除回答" else "放弃输出") }
            }
        }
    }
    if (state.confirmation != null) AlertDialog(onDismissRequest = controller::cancelDiscard, title = { Text(if (state.clearingSuccess) "清除此回答？" else "放弃此生成输出？") }, confirmButton = { TextButton(onClick = controller::confirmDiscard, enabled = enabled && state.writable) { Text("确认") } }, dismissButton = { TextButton(onClick = controller::cancelDiscard) { Text("取消") } })
}
