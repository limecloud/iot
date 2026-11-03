package run.limeai.iot

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.*
import run.limeai.iot.core.VisionRequests

@Composable fun VisionPanel(controller: VisionController, online: Boolean) {
    val state by controller.state.collectAsStateWithLifecycle()
    val context = LocalContext.current; val scope = rememberCoroutineScope(); val lifecycle = LocalLifecycleOwner.current.lifecycle
    var reading by remember { mutableStateOf(false) }; var fileJob by remember { mutableStateOf<Job?>(null) }; var fileGeneration by remember { mutableIntStateOf(0) }
    fun stopReading() { fileGeneration++; fileJob?.cancel(); fileJob = null; reading = false }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null && online && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            stopReading(); reading = true; val epoch = fileGeneration
            fileJob = scope.launch {
                try {
                    val (name, bytes) = withContext(Dispatchers.IO) {
                        val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0)?.take(128) else null } ?: "image"
                        val data = context.contentResolver.openInputStream(uri)?.use { MediaFile.read(it, VisionRequests.MAX_IMAGE_BYTES) } ?: error("unreadable_image")
                        name to data
                    }
                    controller.waitForIdle(); ensureActive()
                    if (epoch == fileGeneration && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) controller.selectFile(name, bytes)
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    controller.waitForIdle(); ensureActive()
                    if (epoch == fileGeneration) controller.fileFailure(error)
                } finally { if (epoch == fileGeneration) { reading = false; fileJob = null } }
            }
        }
    }
    LaunchedEffect(controller, lifecycle, online) {
        if (!online) { stopReading(); controller.pause(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { controller.refresh(); while (true) { delay(1000); controller.poll() } }
            finally { stopReading(); controller.pause() }
        }
    }
    DisposableEffect(controller) { onDispose { stopReading(); controller.pause() } }
    if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("vision-message"))
    OutlinedButton(onClick = controller::refresh, enabled = online && !state.busy && !reading, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) { Text("读取观察状态") }
    if (state.capabilities?.configured == false) Text("网关尚未配置本地视觉服务", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (state.capabilities?.configured == true) {
        OutlinedButton(onClick = { picker.launch(arrayOf("image/png", "image/jpeg")) }, enabled = online && state.editable && !reading, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline), modifier = Modifier.testTag("vision-select")) { Text(if (reading) "正在读取图片" else "选择图片") }
        if (state.fileName.isNotEmpty()) Text(state.fileName, fontSize = 14.sp)
        Text("PNG或JPEG，最多2 MiB，边长不超过1024像素", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        BasicTextField(state.prompt, controller::setPrompt, minLines = 3, maxLines = 6, enabled = online && state.editable && !reading, textStyle = TextStyle(fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface), modifier = Modifier.fillMaxWidth().border(0.5.dp, MaterialTheme.colorScheme.outline).padding(12.dp).semantics { contentDescription = "图片问题，最多512字" }.testTag("vision-prompt"), decorationBox = { inner -> Box { if (state.prompt.isEmpty()) Text("问题，最多512字", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant); inner() } })
        Button(onClick = controller::generate, enabled = online && state.canGenerate && !reading, modifier = Modifier.testTag("vision-generate")) { Text("分析图片") }
    }
    if (state.records.isNotEmpty()) Text("观察记录", fontSize = 16.sp)
    state.records.asReversed().forEach { record -> key(record.key) {
        Text(record.statusText, fontSize = 14.sp)
        state.text(record.key)?.let { text -> SelectionContainer { Text(text, fontSize = 14.sp, modifier = Modifier.testTag("vision-result")) } }
        var expanded by remember { mutableStateOf(false) }
        TextButton(onClick = { expanded = !expanded }) { Text("任务详情") }
        if (expanded) Text(record.key, fontSize = 12.sp)
        if (record.rejectedCode == null) TextButton(onClick = { controller.recover(record.key) }, enabled = online && !state.busy && !reading) { Text("查询原任务") }
        if (record.canDiscard) TextButton(onClick = { controller.requestDiscard(record.key) }, enabled = online && state.writable && !reading) { Text(if (record.status == "succeeded") "清除观察结果" else "放弃输出") }
    } }
    if (state.confirmation != null) AlertDialog(onDismissRequest = controller::cancelDiscard, title = { Text(if (state.clearingSuccess) "清除此观察结果？" else "放弃此观察输出？") }, confirmButton = { TextButton(onClick = controller::confirmDiscard, enabled = online && state.writable) { Text(if (state.clearingSuccess) "清除观察结果" else "放弃输出") } }, dismissButton = { TextButton(onClick = controller::cancelDiscard) { Text("取消") } })
}
