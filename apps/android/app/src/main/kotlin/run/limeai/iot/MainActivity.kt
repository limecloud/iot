package run.limeai.iot

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import run.limeai.iot.core.*
import java.util.UUID

private val Sand1 = Color(0xFFFDFDFC)
private val Sand3 = Color(0xFFF1F0EF)
private val Sand7 = Color(0xFFD3D0CB)
private val Sand11 = Color(0xFF717069)
private val Sand12 = Color(0xFF21201C)
private val Grass3 = Color(0xFFE9F6E9)
private val Grass9 = Color(0xFF46A758)
private val Grass11 = Color(0xFF2A7E3B)
private val Amber11 = Color(0xFFAB6400)
private val Red11 = Color(0xFFCE2C31)
private val colors = lightColorScheme(primary = Grass9, onPrimary = Sand1, primaryContainer = Grass3, onPrimaryContainer = Grass11, secondary = Grass11, onSecondary = Sand1, secondaryContainer = Grass3, onSecondaryContainer = Grass11, tertiary = Grass11, onTertiary = Sand1, tertiaryContainer = Grass3, onTertiaryContainer = Grass11, background = Sand1, onBackground = Sand12, surface = Sand1, onSurface = Sand12, surfaceVariant = Sand3, onSurfaceVariant = Sand11, outline = Sand7, outlineVariant = Sand7, error = Red11, onError = Sand1, errorContainer = Sand3, onErrorContainer = Red11, inverseSurface = Sand12, inverseOnSurface = Sand1, inversePrimary = Grass3, scrim = Sand12, surfaceTint = Grass9, surfaceDim = Sand3, surfaceBright = Sand1, surfaceContainerLowest = Sand1, surfaceContainerLow = Sand1, surfaceContainer = Sand3, surfaceContainerHigh = Sand3, surfaceContainerHighest = Sand3)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); setContent { MaterialTheme(colorScheme = colors) { HomeApp() } } }
}
@Composable private fun HomeApp(vm: HomeViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(vm, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { vm.refresh(); delay(5000) } } }
    if (!state.connected) { Login(state, vm); return }
    var tab by remember { mutableIntStateOf(0) }
    Scaffold(bottomBar = { NavigationBar(containerColor = Sand1, tonalElevation = 0.dp) { listOf("设备", "自动化", "执行记录", "设置").forEachIndexed { index, label -> NavigationBarItem(selected = tab == index, onClick = { tab = index }, icon = {}, label = { Text(label, fontSize = 14.sp) }) } } }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Text(listOf("我的设备", "自动化", "执行记录", "设置")[tab], fontSize = 28.sp)
            if (!state.online) Text("连接中断，当前显示上次观测", fontSize = 12.sp, color = Amber11)
            if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = Amber11)
            when (tab) {
                0 -> Devices(state, vm)
                1 -> Automations(state, vm)
                2 -> Activity(state)
                else -> { Text(state.origin, fontSize = 14.sp); Text(if (state.online) "本地已连接" else "连接中断", fontSize = 14.sp); TextButton(onClick = vm::logout, enabled = !state.busy) { Text("退出登录") } }
            }
            TextButton(onClick = vm::refreshNow) { Text("刷新") }
        }
    }
}
@Composable private fun Login(state: HomeState, vm: HomeViewModel) {
    var origin by remember(state.origin) { mutableStateOf(state.origin) }
    var token by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Spacer(Modifier.height(48.dp)); Text("LimeIoT", fontSize = 16.sp); Text("连接我的家", fontSize = 28.sp)
        OutlinedTextField(origin, { origin = it }, label = { Text("家庭网关 HTTPS 地址") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(token, { token = it }, label = { Text("所有者凭据") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
        if (state.message.isNotEmpty()) Text(state.message, color = Amber11, fontSize = 14.sp)
        Button(onClick = { val input = token; token = ""; vm.connect(origin, input) }, enabled = !state.busy && token.isNotEmpty()) { Text(if (state.busy) "正在连接" else "连接家庭网关") }
    }
}
@Composable private fun Devices(state: HomeState, vm: HomeViewModel) {
    val snapshot = state.snapshot ?: return
    snapshot.devices.forEach { device ->
        OutlinedCard(modifier = Modifier.fillMaxWidth(), border = BorderStroke(0.5.dp, Sand7), colors = CardDefaults.outlinedCardColors(containerColor = Sand1)) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(snapshot.name(device), fontSize = 16.sp)
                Text(if (state.online && device.ready) "在线" else "离线", fontSize = 12.sp, color = if (device.ready && state.online) Grass11 else Amber11)
                val latest = snapshot.commands.items.firstOrNull { it.request.deviceId == device.deviceId }
                val disabled = !state.online || !device.ready || state.busy || state.pending.containsKey(device.deviceId) || latest?.status in listOf("accepted", "dispatched")
                snapshot.models[device.modelRevision]?.services?.forEach { service -> service.properties.forEach { property ->
                    val path = "${service.id}.${property.id}"
                    val observed = device.reported[path]
                    val name = when (property.id) { "power" -> "电源"; "brightness" -> "亮度"; else -> property.id }
                    val writable = property.access.contains("write")
                    when (property.schema.type) {
                        "boolean" -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(name, fontSize = 14.sp); Switch(checked = observed?.value?.toString() == "true", enabled = !disabled && writable && observed != null, onCheckedChange = { vm.control(device, path, JsonPrimitive(it)) }) }
                        "integer" -> {
                            var value by remember(device.deviceId, path) { mutableStateOf(observed?.value?.toString() ?: "0") }
                            LaunchedEffect(observed?.value) { value = observed?.value?.toString() ?: "0" }
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                OutlinedTextField(value, { value = it }, label = { Text(name) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true, enabled = !disabled && writable, modifier = Modifier.weight(1f))
                                Button(onClick = { value.toIntOrNull()?.let { vm.control(device, path, JsonPrimitive(it)) } }, enabled = !disabled && writable && value.toIntOrNull()?.let { it >= (property.schema.minimum ?: Double.NEGATIVE_INFINITY) && it <= (property.schema.maximum ?: Double.POSITIVE_INFINITY) } == true) { Text("设置") }
                            }
                        }
                        else -> Text("$name：${observed?.value ?: "暂无状态"}", fontSize = 14.sp)
                    }
                } }
                if (state.pending.containsKey(device.deviceId)) TextButton(onClick = { vm.recover(device) }, enabled = state.online && !state.busy) { Text("查询原操作") }
                latest?.let { Text("最近操作：${it.statusText}", fontSize = 12.sp, color = if (it.status == "unknown") Amber11 else Sand11) }
                var expanded by remember { mutableStateOf(false) }
                TextButton(onClick = { expanded = !expanded }) { Text("设备详情") }
                if (expanded) { Text(device.deviceId, fontSize = 12.sp); device.reported.forEach { (path, observation) -> Text("$path：${observation.value}\n${if (observation.quality == "stale") "已过期" else "有效"} / ${observation.observedAt}\n来源：${observation.source}", fontSize = 12.sp) } }
            }
        }
    }
}
private data class Source(val device: String, val event: String, val label: String, val schema: ValueSchema)
private data class Target(val device: String, val path: String, val label: String)
@Composable private fun Automations(state: HomeState, vm: HomeViewModel) {
    val snapshot = state.snapshot ?: return
    DraftEditor(state, vm)
    val sources = snapshot.devices.flatMap { device -> snapshot.models[device.modelRevision]?.services?.flatMap { service -> service.events.map { Source(device.deviceId, "${service.id}.${it.id}", "${snapshot.name(device)} ${if (it.id == "pressed") "按下时" else it.id}", it.schema) } }.orEmpty() }
    val targets = snapshot.devices.flatMap { device -> snapshot.models[device.modelRevision]?.services?.flatMap { service -> service.properties.filter { it.schema.type == "boolean" && "write" in it.access }.map { Target(device.deviceId, "${service.id}.${it.id}", "${snapshot.name(device)} ${if (it.id == "power") "电源" else it.id}") } }.orEmpty() }
    var sourceIndex by remember { mutableIntStateOf(0) }; var targetIndex by remember { mutableIntStateOf(0) }
    var value by remember { mutableStateOf(true) }; var cooldown by remember { mutableStateOf("10") }
    var ruleId by remember { mutableStateOf("rule-${UUID.randomUUID()}") }; var reviewed by remember { mutableStateOf<Rule?>(null) }; var simulating by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val source = sources.getOrNull(sourceIndex); val target = targets.getOrNull(targetIndex)
    if (source != null && target != null) {
        Text("设置联动", fontSize = 16.sp)
        Text("当", fontSize = 14.sp); sources.forEachIndexed { index, item -> Row { RadioButton(selected = sourceIndex == index, onClick = { sourceIndex = index }); Text(item.label, fontSize = 14.sp) } }
        Text("执行", fontSize = 14.sp); targets.forEachIndexed { index, item -> Row { RadioButton(selected = targetIndex == index, onClick = { targetIndex = index }); Text(item.label, fontSize = 14.sp) } }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("开启设备", fontSize = 14.sp); Switch(value, { value = it }) }
        OutlinedTextField(cooldown, { cooldown = it }, label = { Text("冷却时间（秒）") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        val seconds = cooldown.toIntOrNull()?.takeIf { it in 0..86400 }
        val rule = seconds?.let { Rule(id = ruleId, trigger = Trigger(source.device, source.event), actions = listOf(Action(target.device, SetValue(target.path, JsonPrimitive(value)))), cooldownMs = it * 1000) }
        OutlinedButton(onClick = { if (rule != null) { reviewed = null; simulating = true; scope.launch { try { val result = vm.simulate(rule, source.schema.sample()); if (result.matched && !result.executed) reviewed = rule } catch (error: Exception) { vm.report(error) } finally { simulating = false } } } }, enabled = state.online && !state.busy && !simulating && rule != null) { Text(if (simulating) "正在预演" else "校验并预演") }
        if (reviewed == rule && rule != null) Text("预演通过，设备尚未执行", color = Grass11, fontSize = 12.sp)
        Button(onClick = { rule?.let(vm::deploy); reviewed = null }, enabled = state.online && !state.busy && !simulating && rule != null && reviewed == rule) { Text("启用自动化") }
    } else Text("连接支持事件和控制的设备后，可以创建联动。", fontSize = 14.sp)
    HorizontalDivider(thickness = 0.5.dp); Text("已启用", fontSize = 16.sp)
    snapshot.deployments.forEach { deployment ->
        Text(sources.firstOrNull { it.device == deployment.rule.trigger.device && it.event == deployment.rule.trigger.event }?.label ?: deployment.rule.id, fontSize = 14.sp)
        Text("最近触发 ${deployment.lastRun ?: "尚无记录"}", fontSize = 12.sp, color = Sand11)
        OutlinedButton(onClick = { vm.stop(deployment) }, enabled = state.online && !state.busy) { Text("停用") }
    }
    TextButton(onClick = { ruleId = "rule-${UUID.randomUUID()}"; reviewed = null }) { Text("新建自动化") }
}
@Composable private fun DraftEditor(state: HomeState, vm: HomeViewModel) {
    val snapshot = state.snapshot ?: return
    fun name(id: String) = snapshot.devices.firstOrNull { it.deviceId == id }?.let(snapshot::name) ?: id
    Text("用一句话设置", fontSize = 16.sp)
    if (snapshot.inference?.configured == true) {
        OutlinedTextField(state.draftPrompt, vm::editDraftPrompt, label = { Text("希望如何联动") }, minLines = 2, maxLines = 5, enabled = !state.draftBusy && state.draft?.status != "running", modifier = Modifier.fillMaxWidth())
        OutlinedButton(onClick = vm::generateDraft, enabled = state.online && !state.busy && !state.draftBusy && state.draftPrompt.isNotBlank() && (state.draftReference == null || (state.draft != null && state.draft.status != "running"))) { Text("生成草案") }
    } else Text("请先在网关配置本地模型。", fontSize = 14.sp, color = Sand11)
    if (state.draftReference != null) {
        OutlinedButton(onClick = vm::recoverDraft, enabled = state.online && !state.busy && !state.draftBusy) { Text("查询生成结果") }
        if (state.draft?.status != "running") TextButton(onClick = vm::newDraft, enabled = !state.busy && !state.draftBusy) { Text("新建草案") }
    }
    state.draft?.let { draft ->
        Text(draft.statusText, fontSize = 14.sp)
        draft.error?.let { Text(GatewayException(it, 422).displayMessage, fontSize = 14.sp, color = Amber11) }
        val rule = draft.rule
        if (draft.status == "completed" && rule != null && state.draftPrompt == draft.request.prompt) {
            Text("当${name(rule.trigger.device)}${if (rule.trigger.event == "button.pressed") "按下时" else "发生 ${rule.trigger.event}"}：", fontSize = 14.sp)
            rule.actions.forEach { action ->
                val path = when (action.set.path) { "light.power" -> "电源"; "light.brightness" -> "亮度"; else -> action.set.path }
                val value = when (action.set.value.toString()) { "true" -> "开启"; "false" -> "关闭"; else -> action.set.value.toString() }
                Text("${name(action.device)}${path}设为$value", fontSize = 14.sp)
            }
            Text("冷却时间 ${rule.cooldownMs / 1000} 秒", fontSize = 12.sp, color = Sand11)
            OutlinedButton(onClick = vm::simulateDraft, enabled = state.online && !state.busy && !state.draftBusy) { Text("预演草案") }
            Button(onClick = vm::deployDraft, enabled = state.online && !state.busy && !state.draftBusy && state.draftProof != null && state.draftProof == draft.ruleRevision) { Text("启用草案") }
            var expanded by remember(draft.draftId) { mutableStateOf(false) }
            TextButton(onClick = { expanded = !expanded }) { Text("草案内容") }
            if (expanded) Text(Json.encodeToString(rule), fontSize = 12.sp)
        }
    }
    if (state.draftMessage.isNotEmpty()) Text(state.draftMessage, fontSize = 14.sp, color = Amber11)
    HorizontalDivider(thickness = 0.5.dp)
}
@Composable private fun Activity(state: HomeState) {
    if (state.snapshot?.commands?.nextCursor != null) Text("最近 100 条设备操作", fontSize = 12.sp, color = Sand11)
    state.snapshot?.commands?.items?.forEach { command ->
        var expanded by remember(command.commandId) { mutableStateOf(false) }
        Text("${if (command.request.operation.path == "light.power") "电源" else "亮度"} ${command.request.operation.value}", fontSize = 14.sp)
        Text(command.statusText, fontSize = 12.sp, color = if (command.status == "unknown") Amber11 else Sand11)
        TextButton(onClick = { expanded = !expanded }) { Text("操作详情") }
        if (expanded) { Text(command.commandId, fontSize = 12.sp); command.runId?.let { Text("关联运行 $it", fontSize = 12.sp) }; command.error?.let { Text(it, fontSize = 12.sp) } }
        HorizontalDivider(thickness = 0.5.dp)
    }
    Text("自动化运行", fontSize = 16.sp)
    state.snapshot?.runs?.forEach { run -> Text("${run.commandIds.size} 个关联操作", fontSize = 14.sp); Text(run.runId, fontSize = 12.sp); run.commandIds.forEach { Text(it, fontSize = 12.sp) } }
}
