package run.limeai.iot

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
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
import run.limeai.iot.core.ObservationProfile

@Composable fun ObservationPanel(controller: ObservationController, online: Boolean) {
    controller.commissioning?.let { ZigbeePanel(it, online) }
    val state by controller.state.collectAsStateWithLifecycle(); val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(controller, online, lifecycle) {
        if (!online) { controller.pause(); return@LaunchedEffect }
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { try { controller.refresh(); while (true) { delay(1000); controller.poll() } } finally { controller.pause() } }
    }
    DisposableEffect(controller) { onDispose { controller.pause() } }
    if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
    OutlinedButton(onClick = controller::refresh, enabled = online && !state.busy, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) { Text("读取接入状态") }
    Text("添加设备", fontSize = 16.sp)
    if (state.coordinators.isEmpty()) Text("请先在网关配置 Zigbee 协调器", fontSize = 14.sp)
    else {
        var expanded by remember { mutableStateOf(false) }
        TextButton(onClick = { expanded = true }, enabled = online && !state.busy) { Text("协调器：${state.coordinator}") }
        DropdownMenu(expanded, { expanded = false }) { state.coordinators.forEach { coordinator -> DropdownMenuItem(text = { Text(coordinator.id) }, onClick = { controller.setCoordinator(coordinator.id); expanded = false }) } }
        OutlinedButton(onClick = controller::discover, enabled = online && state.writable, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline), modifier = Modifier.testTag("observation-discover")) { Text("发现已有设备", fontSize = 14.sp) }
        state.discovery?.let { discovery ->
            Text("协调器邻居记录，可能遗漏设备", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (discovery.items.isEmpty()) Text("未发现邻居记录", fontSize = 14.sp)
            discovery.items.forEach { neighbor -> key(neighbor.ieee) {
                Text(neighbor.ieee, fontSize = 12.sp)
                TextButton(onClick = { controller.readEndpoints(neighbor.ieee) }, enabled = online && state.writable) { Text("读取端点", fontSize = 14.sp) }
            } }
        }
        state.endpoints?.let { endpoints ->
            if (endpoints.items.isEmpty()) Text("未读取到端点", fontSize = 14.sp)
            endpoints.items.forEach { endpoint -> key(endpoint.endpoint) {
                Text("端点 ${endpoint.endpoint}", fontSize = 14.sp)
                if (endpoint.supportsEnvironment || endpoint.supportsOnOff) TextButton(onClick = { controller.queryEndpoint(endpoint.endpoint) }, enabled = online && state.writable) { Text("查询此端点", fontSize = 14.sp) }
                else Text("暂不支持", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } }
        }
        ObservationInput("设备 IEEE，16 位小写十六进制", state.ieee, controller::setIEEE, online && !state.busy, "observation-ieee")
        ObservationInput("端点", state.endpoint, controller::setEndpoint, online && !state.busy, "observation-endpoint")
        var profileExpanded by remember { mutableStateOf(false) }
        TextButton(onClick = { profileExpanded = true }, enabled = online && !state.busy) { Text("设备类型：" + if (state.profile == ObservationProfile.OnOff) "开关" else "温湿度传感器") }
        DropdownMenu(profileExpanded, { profileExpanded = false }) {
            DropdownMenuItem(text = { Text("温湿度传感器") }, onClick = { controller.setProfile(ObservationProfile.Environment); profileExpanded = false })
            DropdownMenuItem(text = { Text("开关") }, onClick = { controller.setProfile(ObservationProfile.OnOff); profileExpanded = false })
        }
        ObservationInput("设备编号", state.device, controller::setDevice, online && !state.busy, "observation-device")
        Button(onClick = controller::query, enabled = online && state.writable, modifier = Modifier.testTag("observation-query")) { Text("查询设备") }
    }
    state.review?.let { review ->
        Text(if (review.candidate == null) "撤销接入" else "核对设备", fontSize = 16.sp)
        Text(review.binding.device, fontSize = 14.sp)
        review.candidate?.let { candidate -> Text(candidate.model, fontSize = 14.sp); Text(candidate.manufacturer, fontSize = 14.sp); Text(candidate.ieee, fontSize = 12.sp); Text("协议响应尚未认证设备身份", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        review.candidate?.let { Text(if (it.profile == ObservationProfile.OnOff) "接入权限：读取和控制电源" else "接入权限：只读温湿度", fontSize = 14.sp) }
        Button(onClick = controller::confirm, enabled = online && state.writable, modifier = Modifier.testTag("observation-confirm")) { Text(if (review.candidate == null) "确认撤销" else "确认添加") }
        TextButton(onClick = controller::cancelReview) { Text("取消") }
    }
    if (state.staticDevices.isNotEmpty()) { Text("配置接入", fontSize = 16.sp); state.staticDevices.forEach { Text(it.deviceId, fontSize = 14.sp) } }
    if (state.bindings.isNotEmpty()) Text("托管设备", fontSize = 16.sp)
    state.bindings.forEach { binding ->
        Text(binding.device, fontSize = 14.sp); Text(if (binding.active) "已接入" else "已撤销", fontSize = 12.sp)
        if (binding.active) TextButton(onClick = { controller.reviewRevoke(binding.device) }, enabled = online && state.writable) { Text("撤销接入") }
        else TextButton(onClick = { controller.rebind(binding) }, enabled = online && state.writable) { Text("重新接入") }
    }
    if (state.records.isNotEmpty()) Text("接入记录", fontSize = 16.sp)
    state.records.asReversed().forEach { record -> key(record.key) {
        Text(record.device + " " + record.statusText, fontSize = 14.sp)
        var expanded by remember { mutableStateOf(false) }
        TextButton(onClick = { expanded = !expanded }) { Text("原请求") }; if (expanded) Text(record.key, fontSize = 12.sp)
        TextButton(onClick = { controller.recover(record.key) }, enabled = online && !state.busy) { Text("查询原操作") }
    } }
}

@Composable private fun ObservationInput(label: String, value: String, changed: (String) -> Unit, enabled: Boolean, tag: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        BasicTextField(value, changed, singleLine = true, enabled = enabled, textStyle = TextStyle(fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface), modifier = Modifier.fillMaxWidth().border(0.5.dp, MaterialTheme.colorScheme.outline).padding(12.dp).semantics { contentDescription = label }.testTag(tag))
    }
}
