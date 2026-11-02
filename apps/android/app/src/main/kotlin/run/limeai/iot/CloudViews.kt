package run.limeai.iot

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonObject
import run.limeai.iot.core.*

@Composable internal fun ConnectionOptions(cloud: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        listOf(false to "家庭网关", true to "云服务").forEach { (value, label) ->
            OutlinedButton(onClick = { onChange(value) }, enabled = value != cloud, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) { Text(label, fontSize = 14.sp) }
        }
    }
}

@Composable internal fun CloudHome(onLocal: () -> Unit) {
    val context = LocalContext.current.applicationContext
    val preferences = remember(context) { context.getSharedPreferences("home", Context.MODE_PRIVATE) }
    val factory = remember(context) { viewModelFactory { initializer { CloudViewModel(SecureStore(context), preferences.getString("control.origin", "").orEmpty(), { preferences.edit().putString("control.origin", it).apply() }) } } }
    val vm: CloudViewModel = viewModel(factory = factory)
    val state by vm.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(vm, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            vm.enterForeground()
            try { while (true) { vm.tick(); delay(3000) } } finally { vm.leaveForeground() }
        }
    }
    if (state.principal == null) { CloudLogin(state, vm, onLocal); return }
    var tab by remember { mutableIntStateOf(0) }
    val titles = listOf("设备", "操作记录", "设置")
    Scaffold(bottomBar = {
        NavigationBar(tonalElevation = 0.dp) {
            titles.forEachIndexed { index, title -> NavigationBarItem(selected = tab == index, onClick = { tab = index }, icon = {}, label = { Text(title, fontSize = 14.sp) }) }
        }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text(titles[tab], fontSize = 28.sp)
            if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
            when (tab) {
                0 -> CloudDevices(state, vm)
                1 -> CloudRecords(state, vm)
                else -> {
                    Text(state.origin, fontSize = 14.sp); Text(state.principal?.name.orEmpty(), fontSize = 14.sp)
                    Text(if (state.online) "已连接" else "连接中断", fontSize = 14.sp)
                    TextButton(onClick = vm::logout, enabled = !state.busy) { Text("退出登录", fontSize = 14.sp) }
                }
            }
            TextButton(onClick = vm::refresh, enabled = !state.busy) { Text("刷新", fontSize = 14.sp) }
        }
    }
}
@Composable private fun CloudLogin(state: CloudState, vm: CloudViewModel, onLocal: () -> Unit) {
    var origin by remember(state.origin) { mutableStateOf(state.origin) }
    val context = LocalContext.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        if (!state.pendingAuthorization && !state.busy) ConnectionOptions(true) { if (!it) onLocal() }
        Text("LimeIoT", fontSize = 28.sp)
        OutlinedTextField(origin, { origin = it }, label = { Text("控制面 HTTPS 地址", fontSize = 14.sp) }, singleLine = true, enabled = !state.busy && !state.pendingAuthorization, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth())
        if (state.login == null && !state.pendingAuthorization) {
            Button(onClick = { vm.begin(origin) }, enabled = !state.busy && origin.isNotBlank()) { Text("登录", fontSize = 14.sp) }
        }
        if (state.login == null) {
            TextButton(onClick = { vm.restore(origin) }, enabled = !state.busy && origin.isNotBlank()) { Text("恢复会话", fontSize = 14.sp) }
        }
        state.login?.let { login ->
            Text("授权码", fontSize = 14.sp)
            Text(login.userCode, fontSize = 28.sp, fontFamily = FontFamily.Monospace)
            Text("在浏览器登录控制台，输入此码并批准。", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = {
                try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(login.verificationUri)).addCategory(Intent.CATEGORY_BROWSABLE)) }
                catch (_: android.content.ActivityNotFoundException) { vm.browserFailed() }
                catch (_: SecurityException) { vm.browserFailed() }
            }, enabled = !state.busy) { Text("打开浏览器", fontSize = 14.sp) }
            if (!state.polling) TextButton(onClick = vm::resumePolling, enabled = !state.busy) { Text("继续查询", fontSize = 14.sp) }
        }
        if (state.pendingAuthorization) TextButton(onClick = vm::cancel, enabled = !state.busy) { Text("结束本次登录", fontSize = 14.sp) }
        if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = MaterialTheme.colorScheme.error)
    }
}
@Composable private fun CloudDevices(state: CloudState, vm: CloudViewModel) {
    var choosingSpace by remember { mutableStateOf(false) }
    if (!state.online) Text("连接中断，当前显示上次观测", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
    Box {
        TextButton(onClick = { choosingSpace = true }, enabled = !state.busy && state.spaces.isNotEmpty()) { Text("空间：${state.spaces.firstOrNull { it.spaceId == state.space }?.name ?: "暂无空间"}", fontSize = 14.sp) }
        DropdownMenu(expanded = choosingSpace, onDismissRequest = { choosingSpace = false }) {
            state.spaces.forEach { space -> DropdownMenuItem(text = { Text(space.name, fontSize = 14.sp) }, onClick = { choosingSpace = false; vm.selectSpace(space.spaceId) }) }
        }
    }
    if (state.spaces.isEmpty()) Text("暂无空间，请先在控制台创建。", fontSize = 14.sp)
    if (state.gateway == null && state.space.isNotEmpty() && state.online) Text("此空间尚未配对网关。", fontSize = 14.sp)
    state.gateway?.let { Text("网关：${it.gatewayId}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    state.devices.forEach { device ->
        OutlinedCard(Modifier.fillMaxWidth(), border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline)) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(device.deviceId, fontSize = 16.sp)
                Text(if (state.online && device.ready) "在线" else "离线", fontSize = 12.sp)
                state.models[device.modelRevision]?.services?.forEach { service ->
                    service.properties.forEach { property -> CloudProperty(state, vm, device, property, "${service.id}.${property.id}") }
                    val disabled = !state.foreground || !state.online || state.busy || !device.ready || state.gateway?.scopes?.contains("commands.write") != true || state.blocked(device)
                    service.actions.forEach { action -> DeviceActions(action, "${service.id}.${action.id}", disabled) { vm.control(device, "${service.id}.${action.id}", it, "action.invoke") } }
                }
                state.records.filter { it.reference.request.deviceId == device.deviceId && it.rejection == null && it.result?.status?.terminal != true }.forEach { record ->
                    Text(record.cloudStatus, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = { vm.resolve(record) }, enabled = !state.busy) { Text("查询原操作", fontSize = 14.sp) }
                }
            }
        }
    }
    if (state.gateway != null && state.devices.isEmpty() && state.online) Text("暂无设备", fontSize = 14.sp)
    if (state.hasMore) TextButton(onClick = vm::loadMore, enabled = !state.busy) { Text("加载更多", fontSize = 14.sp) }
}
@Composable private fun CloudProperty(state: CloudState, vm: CloudViewModel, device: Device, property: Property, path: String) {
    val disabled = !state.foreground || !state.online || state.busy || !device.ready || "write" !in property.access || state.gateway?.scopes?.contains("commands.write") != true || state.blocked(device)
    val observed = device.reported[path]
    val name = when (property.id) { "power" -> "电源"; "brightness" -> "亮度"; else -> property.id }
    when (property.schema.type) {
        "boolean" -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(name, fontSize = 14.sp)
            Switch(checked = observed?.value?.toString() == "true", onCheckedChange = { vm.control(device, path, JsonPrimitive(it)) }, enabled = !disabled && observed != null)
        }
        "integer", "number" -> {
            var number by remember(device.deviceId, path) { mutableStateOf(observed?.value?.toString().orEmpty()) }
            val parsed = number.toDoubleOrNull()?.takeIf { it.isFinite() && it >= (property.schema.minimum ?: Double.NEGATIVE_INFINITY) && it <= (property.schema.maximum ?: Double.POSITIVE_INFINITY) }
            val value = if (property.schema.type == "integer") number.toLongOrNull()?.takeIf { parsed != null }?.let(::JsonPrimitive) else parsed?.let(::JsonPrimitive)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(number, { number = it }, label = { Text(name, fontSize = 14.sp) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), enabled = !disabled, modifier = Modifier.weight(1f))
                Button(onClick = { value?.let { vm.control(device, path, it) } }, enabled = !disabled && value != null) { Text("设置", fontSize = 14.sp) }
            }
        }
        else -> Text("$name：${observed?.value ?: "暂无状态"}", fontSize = 14.sp)
    }
}
@Composable private fun CloudRecords(state: CloudState, vm: CloudViewModel) {
    if (state.records.isEmpty()) Text("当前空间暂无本机操作记录", fontSize = 14.sp)
    state.records.asReversed().forEach { record ->
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(record.reference.request.deviceId, fontSize = 16.sp)
            Text(record.reference.request.operation.summary, fontSize = 14.sp)
            Text(record.cloudStatus, fontSize = 14.sp)
            if (record.rejection != null || record.result?.status?.terminal == true) TextButton(onClick = { vm.forget(record) }, enabled = !state.busy) { Text("清理记录", fontSize = 14.sp) }
            else TextButton(onClick = { vm.resolve(record) }, enabled = !state.busy) { Text("查询原操作", fontSize = 14.sp) }
        }
        HorizontalDivider(thickness = 0.5.dp)
    }
}
private val ControlCommandRecord.cloudStatus: String get() = if (rejection != null) "已拒绝" else when (result?.status ?: ControlCommandStatus.UNKNOWN) {
    ControlCommandStatus.UNKNOWN -> "结果待查询"
    ControlCommandStatus.ACCEPTED -> "已受理"
    ControlCommandStatus.DISPATCHED -> "已发送，等待设备结果"
    ControlCommandStatus.CONFIRMED -> if (reference.request.operation.type == "action.invoke") Command.actionStatus((result?.localResult as? JsonObject)?.get("evidence")) else "设备已完成"
    ControlCommandStatus.FAILED -> "设备执行失败"
    ControlCommandStatus.EXPIRED -> "已过期"
    ControlCommandStatus.REJECTED -> "已拒绝"
}
