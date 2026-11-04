package run.limeai.iot

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
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
import kotlinx.coroutines.delay

@Composable fun ZigbeePanel(controller: ZigbeeController, online: Boolean) {
    val state by controller.state.collectAsStateWithLifecycle(); val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(controller, online, lifecycle) {
        if (!online) { controller.pause(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { try { controller.refresh(); while (true) { delay(1000); controller.poll() } } finally { controller.pause() } }
    }
    DisposableEffect(controller) { onDispose { controller.pause() } }
    Text("Zigbee 入网", fontSize = 16.sp)
    if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
    OutlinedButton(onClick = controller::refresh, enabled = online && !state.busy, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) { Text("读取入网状态") }
    if (state.coordinators.isEmpty()) Text("尚未配置可管理的协调器", fontSize = 14.sp)
    else {
        var expanded by remember { mutableStateOf(false) }
        TextButton(onClick = { expanded = true }, enabled = online && !state.busy) { Text("入网协调器：${state.coordinator}") }
        DropdownMenu(expanded, { expanded = false }) { state.coordinators.forEach { coordinator -> DropdownMenuItem(text = { Text(coordinator.id) }, onClick = { controller.setCoordinator(coordinator.id); expanded = false }) } }
        Column {
            Text("开放时长（秒）", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            BasicTextField(state.seconds, controller::setSeconds, singleLine = true, enabled = online && !state.busy, textStyle = TextStyle(fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface), modifier = Modifier.fillMaxWidth().border(0.5.dp, MaterialTheme.colorScheme.outline).padding(12.dp).semantics { contentDescription = "开放时长（秒）" }.testTag("zigbee-seconds"))
        }
        OutlinedButton(onClick = { controller.prepare() }, enabled = online && state.writable, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline), modifier = Modifier.testTag("zigbee-open")) { Text("开放入网") }
        OutlinedButton(onClick = { controller.prepare(close = true) }, enabled = online && state.writable, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline), modifier = Modifier.testTag("zigbee-close")) { Text("关闭入网") }
    }
    state.review?.let { review ->
        Text(if (review.preparation.seconds == 0) "确认关闭入网" else "确认开放入网", fontSize = 16.sp)
        Text(review.preparation.coordinator.id, fontSize = 14.sp); Text(review.preparation.coordinator.ieee, fontSize = 12.sp)
        Text(if (review.preparation.seconds == 0) "关闭入网" else "开放${review.preparation.seconds}秒", fontSize = 14.sp)
        if (review.preparation.seconds > 0) Text("设备加入后仍需单独添加", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = controller::confirm, enabled = online && state.writable, modifier = Modifier.testTag("zigbee-confirm")) { Text(if (review.preparation.seconds == 0) "确认关闭" else "确认开放") }
        TextButton(onClick = controller::cancelReview, enabled = !state.busy) { Text("取消入网操作") }
    }
    if (state.entries.isNotEmpty()) Text("入网操作记录", fontSize = 16.sp)
    state.entries.asReversed().forEach { record -> key(record.key) {
        Text(if (record.seconds == 0) "关闭入网：${record.coordinator}" else "开放${record.seconds}秒：${record.coordinator}", fontSize = 14.sp)
        Text(record.statusText, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        var expanded by remember { mutableStateOf(false) }
        TextButton(onClick = { expanded = !expanded }) { Text("原请求") }; if (expanded) Text(record.key, fontSize = 12.sp)
        TextButton(onClick = { controller.recover(record.key) }, enabled = online && !state.busy) { Text("查询原入网操作") }
    } }
}
