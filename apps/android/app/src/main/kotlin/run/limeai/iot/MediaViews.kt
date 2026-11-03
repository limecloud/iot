package run.limeai.iot

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import run.limeai.iot.core.*

@Composable fun MediaPanel(controller: MediaController, names: Map<String, String>, online: Boolean, speech: SpeechController? = null, transcription: TranscriptionController? = null) {
    val state by controller.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var reading by remember { mutableStateOf(false) }
    var fileJob by remember { mutableStateOf<Job?>(null) }
    var fileGeneration by remember { mutableIntStateOf(0) }
    fun stopReading() { fileGeneration++; fileJob?.cancel(); fileJob = null; reading = false }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            stopReading(); reading = true; val epoch = fileGeneration
            fileJob = scope.launch {
                try {
                    val (name, bytes) = withContext(Dispatchers.IO) {
                        val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0)?.take(128) else null } ?: "audio.wav"
                        val data = context.contentResolver.openInputStream(uri)?.use { MediaFile.read(it) } ?: error("unreadable_audio")
                        name to data
                    }
                    controller.waitForIdle(); ensureActive()
                    if (epoch == fileGeneration) controller.selectFile(name, bytes)
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    controller.waitForIdle(); ensureActive()
                    if (epoch == fileGeneration) controller.fileFailure(error)
                }
                finally { if (epoch == fileGeneration) { reading = false; fileJob = null } }
            }
        }
    }
    LaunchedEffect(controller, lifecycle, online) {
        if (!online) { stopReading(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { controller.refresh(); awaitCancellation() }
            finally { stopReading(); controller.pause() }
        }
    }
    DisposableEffect(controller) { onDispose { stopReading(); controller.pause() } }
    val writable = state.writable && online && !reading
    if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("media-message"))
    OutlinedButton(onClick = controller::refresh, enabled = !state.busy && online && !reading, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) { Text(if (state.busy) "正在读取" else "读取音频状态") }
    if (state.page?.configured == false) Text("此网关未启用音频服务", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (speech != null) SpeechPanel(speech, online)
    if (transcription != null) TranscriptionPanel(transcription, online)
    Text("上传音频", fontSize = 16.sp)
    OutlinedButton(onClick = { picker.launch(arrayOf("audio/wav", "audio/x-wav", "audio/vnd.wave", "application/octet-stream")) }, enabled = writable, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) { Text(if (reading) "正在读取文件" else "选择 WAV 文件") }
    if (state.fileName.isNotEmpty()) Text(state.fileName, fontSize = 14.sp)
    Text("16 位 PCM，最多 4 MiB、60 秒", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    MediaPicker("保留时间", state.retainSeconds.toString(), listOf("600" to "10 分钟", "3600" to "1 小时", "86400" to "24 小时"), writable) { controller.setRetention(it.toInt()) }
    Button(onClick = controller::upload, enabled = writable && state.fileName.isNotEmpty(), modifier = Modifier.testTag("media-upload")) { Text("上传音频") }
    HorizontalDivider(thickness = 0.5.dp); Text("音频", fontSize = 16.sp)
    if (state.page?.items.isNullOrEmpty()) Text("暂无音频", fontSize = 14.sp)
    state.page?.items?.forEach { item ->
        Text(item.id, fontSize = 14.sp)
        Text(if (item.deletedAt != null) "已删除" else if (item.available) "可用" else "不可用", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(String.format(java.util.Locale.ROOT, "%.1f 秒 / %d 字节", item.durationSeconds, item.byteLength), fontSize = 12.sp)
        Text("到期：" + item.expiresAt, fontSize = 12.sp)
        if (item.deletedAt == null) TextButton(onClick = { controller.requestDelete(item.id) }, enabled = writable) { Text("删除音频") }
    }
    HorizontalDivider(thickness = 0.5.dp); Text("音箱授权", fontSize = 16.sp)
    MediaPicker("音频", state.selectedMedia, state.page?.items.orEmpty().filter { it.available }.map { it.id to it.id }, writable, controller::selectMedia)
    MediaPicker("音箱", state.selectedTarget, state.targets.map { it.deviceId to (names[it.deviceId] ?: it.deviceId) }, writable, controller::selectTarget)
    if (state.targets.isEmpty()) Text("请先在家庭网页绑定支持音频的音箱", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    MediaPicker("授权期限", state.grantSeconds.toString(), listOf("30" to "30 秒", "300" to "5 分钟", "600" to "10 分钟"), writable) { controller.setGrantDuration(it.toInt()) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(state.approved, controller::approve, enabled = writable && state.selectedMedia.isNotEmpty() && state.selectedTarget.isNotEmpty())
        Text("允许所选音箱读取此音频", fontSize = 14.sp)
    }
    Button(onClick = controller::grant, enabled = state.canGrant && writable, modifier = Modifier.testTag("media-grant")) { Text("授权音箱") }
    Text("授权后请在设备页播放", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    HorizontalDivider(thickness = 0.5.dp); Text("已有授权", fontSize = 16.sp)
    if (state.page?.grants.isNullOrEmpty()) Text("暂无授权", fontSize = 14.sp)
    state.page?.grants?.forEach { grant ->
        Text(names[grant.deviceId] ?: grant.deviceId, fontSize = 14.sp); Text(grant.mediaId, fontSize = 12.sp)
        Text(if (grant.active) "当前有效" else "当前无效", fontSize = 12.sp)
        Text("到期：" + grant.expiresAt, fontSize = 12.sp)
        if (grant.document["revoked_at"] == JsonNull) TextButton(onClick = { controller.revoke(grant.id) }, enabled = writable) { Text("撤销授权") }
    }
    HorizontalDivider(thickness = 0.5.dp); Text("音频原操作", fontSize = 16.sp)
    state.records.asReversed().forEach { record ->
        Text(record.statusText, fontSize = 14.sp); Text(record.key, fontSize = 12.sp)
        var expanded by remember(record.key) { mutableStateOf(false) }
        TextButton(onClick = { expanded = !expanded }) { Text("原操作详情") }
        if (expanded) Text(OtaJSON.canonical(buildJsonObject { put("original", record.original); put("result", record.result ?: JsonNull) }), fontSize = 12.sp)
        TextButton(onClick = { controller.recover(record.key) }, enabled = !state.busy && online && !reading) { Text("查询音频原操作") }
    }
    state.deletion?.let { id -> AlertDialog(onDismissRequest = controller::cancelDelete, title = { Text("删除此音频及其授权？") }, text = { Text(id, fontSize = 12.sp) }, confirmButton = { TextButton(onClick = controller::confirmDelete, enabled = writable) { Text("删除音频") } }, dismissButton = { TextButton(onClick = controller::cancelDelete) { Text("取消") } }) }
}
@Composable internal fun MediaPicker(label: String, selected: String, items: List<Pair<String, String>>, enabled: Boolean, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }, enabled = enabled && items.isNotEmpty(), border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) { Text(label + "：" + (items.firstOrNull { it.first == selected }?.second ?: "请选择"), fontSize = 14.sp) }
        DropdownMenu(expanded && enabled, { expanded = false }) { items.forEach { (id, name) -> DropdownMenuItem(text = { Text(name, fontSize = 14.sp) }, onClick = { onSelect(id); expanded = false }) } }
    }
}
