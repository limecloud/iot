package run.limeai.iot

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.*
import run.limeai.iot.core.*

@Composable fun CompositionPanel(vm: HomeViewModel, home: HomeState) {
    val snapshot = home.snapshot ?: return
    val scope = rememberCoroutineScope()
    val client = remember(vm, home.origin, snapshot.space) { vm.compositionClient() } ?: return
    val controller = remember(client) { CompositionController(client, scope, vm::report) }
    val state by controller.state.collectAsStateWithLifecycle()
    var expanded by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val fingerprint = snapshot.devices.map { "${it.deviceId}:${it.modelRevision}:${it.ready}" }.sorted().joinToString(",")
    LaunchedEffect(controller, fingerprint) { controller.updateDevices(snapshot.devices); if (expanded && !controller.state.value.ready) controller.refresh() }
    LaunchedEffect(controller, expanded, home.online, lifecycle) {
        controller.setOnline(home.online)
        if (!expanded || !home.online) { controller.pause(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { controller.refresh(); while (isActive) { delay(1000); controller.poll() } } finally { controller.pause() }
        }
    }
    DisposableEffect(controller) { onDispose { controller.close() } }
    TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "收起组合包" else "使用组合包") }
    if (!expanded) return
    if (state.message.isNotEmpty()) Text(state.message, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    val record = state.record
    if (record != null) {
        Text(record.compiled.manifest.name, fontSize = 16.sp)
        Text(if (record.state == "acknowledged") "启用回执已确认" else if (record.state == "rejected") "提交未获接受" else "原提交结果待核实", fontSize = 14.sp)
        OutlinedButton(onClick = controller::query, enabled = state.writable, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) { Text("查询当前部署") }
        if (record.state != "attempted") TextButton(onClick = controller::prepareAnother, enabled = state.writable) { Text("准备其他组合") }
        var showRecord by remember(record.json) { mutableStateOf(false) }
        TextButton(onClick = { showRecord = !showRecord }) { Text("原提交内容") }
        if (showRecord) Text(record.json, fontSize = 12.sp)
    } else {
        Row {
            TextButton(onClick = { controller.setCustom(false) }, enabled = state.canEdit && state.custom) { Text("触摸伴读灯") }
            TextButton(onClick = { controller.setCustom(true) }, enabled = state.canEdit && !state.custom) { Text("自定义组合包") }
        }
        if (state.custom) {
            OutlinedTextField(value = state.source, onValueChange = controller::setSource, label = { Text("组合包 JSON") }, minLines = 6, enabled = state.canEdit, modifier = Modifier.fillMaxWidth())
            if (state.source.isNotEmpty() && state.manifest == null) Text("组合包格式不正确", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
        }
        state.manifest?.let { manifest ->
            for (role in manifest.roles) {
                var menu by remember(role) { mutableStateOf(false) }
                Text(mapOf("touch" to "触摸模块", "light" to "灯光模块")[role] ?: role, fontSize = 14.sp)
                Box {
                    OutlinedButton(onClick = { menu = true }, enabled = state.canEdit, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) {
                        Text(state.bindings[role]?.takeIf { it.isNotEmpty() }?.let { id -> snapshot.devices.firstOrNull { it.deviceId == id }?.let { snapshot.name(it) + "（$id）" } ?: id } ?: "选择兼容设备")
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("选择兼容设备") }, onClick = { controller.bind(role, ""); menu = false })
                        snapshot.devices.filter { it.ready && it.modelRevision == manifest.modelRevision(role) }.forEach { device ->
                            DropdownMenuItem(text = { Text(snapshot.name(device) + "（${device.deviceId}）") }, onClick = { controller.bind(role, device.deviceId); menu = false })
                        }
                    }
                }
            }
        }
        OutlinedButton(onClick = controller::plan, enabled = controller.canPlan(), border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline), modifier = Modifier.testTag("composition-plan")) { Text(if (state.busy) "正在处理" else "预演组合") }
        Button(onClick = controller::deploy, enabled = controller.canDeploy(), modifier = Modifier.testTag("composition-deploy")) { Text("启用组合") }
        state.preview?.let { preview ->
            preview.compiled.typedRule.actions.forEach { action -> Text(snapshot.devices.firstOrNull { it.deviceId == action.device }?.let(snapshot::name).orEmpty() + " " + action.operation.summary, fontSize = 14.sp) }
            var details by remember(preview) { mutableStateOf(false) }
            TextButton(onClick = { details = !details }) { Text("组合与权限内容") }
            if (details) Text(preview.json, fontSize = 12.sp)
        }
    }
    TextButton(onClick = controller::refresh, enabled = home.online && !state.busy && !state.blocked) { Text("读取组合状态") }
}
