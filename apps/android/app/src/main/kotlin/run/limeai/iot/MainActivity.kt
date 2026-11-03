package run.limeai.iot

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
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
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val transparent = android.graphics.Color.TRANSPARENT
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.light(transparent, transparent), navigationBarStyle = SystemBarStyle.light(transparent, transparent))
        setContent { MaterialTheme(colorScheme = colors) { HomeApp() } }
    }
}
@Composable private fun HomeApp(vm: HomeViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current.applicationContext
    val preferences = remember(context) { context.getSharedPreferences("home", android.content.Context.MODE_PRIVATE) }
    var cloud by remember { mutableStateOf(preferences.getString("connection.mode", "nas") == "cloud") }
    fun selectCloud(value: Boolean) { cloud = value; preferences.edit().putString("connection.mode", if (value) "cloud" else "nas").apply() }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(vm, lifecycle, cloud) {
        if (cloud) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try {
                if (!vm.state.value.connected && vm.state.value.origin.isNotEmpty()) vm.connect(vm.state.value.origin, null, true)
                while (true) { vm.refresh(); delay(5000) }
            } finally { vm.pauseMedia() }
        }
    }
    if (cloud) { CloudHome { selectCloud(false) }; return }
    if (!state.connected) { Login(state, vm) { selectCloud(true) }; return }
    var tab by remember { mutableIntStateOf(0) }
    var firmwareOpen by remember { mutableStateOf(false) }
    var mediaOpen by remember { mutableStateOf(false) }
    var visionOpen by remember { mutableStateOf(false) }
    val visionController = state.vision
    val visionBusy = visionController?.state?.collectAsStateWithLifecycle()?.value?.busy == true
    val firmwareController = state.firmware
    val firmwareBusy = firmwareController?.state?.collectAsStateWithLifecycle()?.value?.busy == true
    val mediaController = state.media
    val mediaBusy = mediaController?.state?.collectAsStateWithLifecycle()?.value?.busy == true
    val transcriptionBusy = state.transcription?.state?.collectAsStateWithLifecycle()?.value?.busy == true
    val speechBusy = state.speech?.state?.collectAsStateWithLifecycle()?.value?.busy == true
    Scaffold(bottomBar = { NavigationBar(containerColor = Sand1, tonalElevation = 0.dp) { listOf("设备", "自动化", "执行记录", "设置").forEachIndexed { index, label -> NavigationBarItem(modifier = Modifier.testTag("nas-tab-$index"), selected = tab == index, onClick = { tab = index }, icon = {}, label = { Text(label, fontSize = 14.sp) }) } } }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Text(if (tab == 3 && firmwareOpen) "固件升级" else if (tab == 3 && mediaOpen) "音频" else if (tab == 3 && visionOpen) "图片观察" else listOf("我的设备", "自动化", "执行记录", "设置")[tab], fontSize = 28.sp)
            if (!state.online) Text("连接中断，当前显示上次观测", fontSize = 12.sp, color = Amber11)
            if (state.message.isNotEmpty()) Text(state.message, fontSize = 14.sp, color = Amber11)
            when (tab) {
                0 -> Devices(state, vm)
                1 -> Automations(state, vm)
                2 -> Activity(state)
                else -> if (firmwareOpen && firmwareController != null) {
                    TextButton(onClick = { firmwareOpen = false }) { Text("返回设置") }
                    FirmwarePanel(firmwareController, state.snapshot?.devices.orEmpty(), state.online && !state.busy)
                } else if (mediaOpen && mediaController != null) {
                    TextButton(onClick = { mediaOpen = false }) { Text("返回设置") }
                    MediaPanel(mediaController, state.snapshot?.let { snapshot -> snapshot.devices.associate { it.deviceId to snapshot.name(it) } }.orEmpty(), state.online && !state.busy, state.speech, state.transcription)
                } else if (visionOpen && visionController != null) {
                    TextButton(onClick = { visionOpen = false }) { Text("返回设置") }
                    VisionPanel(visionController, state.online && !state.busy)
                } else {
                    Text(state.origin, fontSize = 14.sp); Text(if (state.online) "本地已连接" else "连接中断", fontSize = 14.sp)
                    if (state.firmware != null) TextButton(onClick = { firmwareOpen = true; mediaOpen = false; visionOpen = false }, modifier = Modifier.testTag("nas-firmware")) { Text("固件升级") }
                    if (mediaController != null) TextButton(onClick = { mediaOpen = true; firmwareOpen = false; visionOpen = false }, modifier = Modifier.testTag("nas-media")) { Text("音频") }
                    if (visionController != null) TextButton(onClick = { visionOpen = true; firmwareOpen = false; mediaOpen = false }, modifier = Modifier.testTag("nas-vision")) { Text("图片观察") }
                    TextButton(onClick = vm::logout, enabled = !state.busy && !firmwareBusy && !mediaBusy && !speechBusy && !transcriptionBusy && !visionBusy) { Text("退出登录") }
                }
            }
            TextButton(onClick = vm::refreshNow) { Text("刷新") }
        }
    }
}
@Composable private fun Login(state: HomeState, vm: HomeViewModel, onCloud: () -> Unit) {
    var origin by remember(state.origin) { mutableStateOf(state.origin) }
    var token by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        if (!state.busy) ConnectionOptions(false) { if (it) onCloud() }
        Spacer(Modifier.height(48.dp)); Text("LimeIoT", fontSize = 16.sp); Text("连接我的家", fontSize = 28.sp)
        OutlinedTextField(origin, { origin = it }, label = { Text("家庭网关 HTTPS 地址") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth().testTag("nas-origin"))
        OutlinedTextField(token, { token = it }, label = { Text("所有者凭据") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth().testTag("nas-credential"))
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
                snapshot.models[device.modelRevision]?.services?.forEach { service ->
                    service.properties.forEach { property ->
                        val path = "${service.id}.${property.id}"
                        val observed = device.reported[path]
                        val name = property.displayName
                        val writable = property.access.contains("write")
                        if (!writable) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(name, fontSize = 14.sp)
                            Column(horizontalAlignment = Alignment.End) {
                                Text(property.displayValue(observed?.value), fontSize = 14.sp)
                                if (observed?.quality == "stale") Text("已过期", fontSize = 12.sp, color = Sand11)
                            }
                        } else when (property.schema.type) {
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
                    }
                    service.actions.forEach { action -> DeviceActions(action, "${service.id}.${action.id}", disabled) { vm.control(device, "${service.id}.${action.id}", it, "action.invoke") } }
                }
                if (state.pending.containsKey(device.deviceId)) TextButton(onClick = { vm.recover(device) }, enabled = state.online && !state.busy) { Text("查询原操作") }
                latest?.let { Text("最近操作：${it.statusText}", fontSize = 12.sp, color = if (it.status == "unknown") Amber11 else Sand11) }
                var expanded by remember { mutableStateOf(false) }
                TextButton(onClick = { expanded = !expanded }) { Text("设备详情") }
                if (expanded) { Text(device.deviceId, fontSize = 12.sp); device.reported.forEach { (path, observation) -> Text("$path：${observation.value}\n${if (observation.quality == "stale") "已过期" else "有效"} / ${observation.observedAt}\n来源：${observation.source}", fontSize = 12.sp) } }
            }
        }
    }
}
private data class Source(val device: String, val event: String, val label: String, val schema: ValueSchema, val property: Property? = null) {
    fun matches(trigger: Trigger) = device == trigger.device && if (property == null) event == trigger.event else event == trigger.property?.path && property.unit == trigger.property?.unit
}
private data class Target(val device: String, val path: String, val label: String, val type: String, val sample: JsonElement, val schema: ValueSchema)
@Composable private fun Automations(state: HomeState, vm: HomeViewModel) {
    val snapshot = state.snapshot ?: return
    DraftEditor(state, vm)
    val sources = snapshot.devices.flatMap { device -> snapshot.models[device.modelRevision]?.services?.flatMap { service ->
        service.events.map { Source(device.deviceId, "${service.id}.${it.id}", "${snapshot.name(device)} ${if (it.id == "pressed") "按下时" else it.id}", it.schema) } +
        service.properties.filter { it.schema.type in listOf("integer", "number") && "read" in it.access && "notify" in it.access && it.unit != null }.map { Source(device.deviceId, "${service.id}.${it.id}", "${snapshot.name(device)} ${it.displayName}", it.schema, it) }
    }.orEmpty() }.sortedBy { if (it.property == null) 0 else 1 }
    val targets = snapshot.devices.flatMap { device -> snapshot.models[device.modelRevision]?.services?.flatMap { service ->
        service.properties.filter { it.schema.type in listOf("boolean", "integer", "number") && "write" in it.access }.map { Target(device.deviceId, "${service.id}.${it.id}", "${snapshot.name(device)} ${it.displayName}", "property.set", it.schema.sample(), it.schema) } +
        service.actions.map { Target(device.deviceId, "${service.id}.${it.id}", "${snapshot.name(device)} ${service.id}.${it.id}", "action.invoke", it.input.sample(), it.input) }
    }.orEmpty() }
    var sourceIndex by remember { mutableIntStateOf(0) }; var targetIndex by remember { mutableIntStateOf(0) }
    var scheduled by remember { mutableStateOf(false) }; var scheduleTime by remember { mutableStateOf("22:00") }
    var timeZone by remember { mutableStateOf(java.time.ZoneId.systemDefault().id) }; var weekdays by remember { mutableStateOf(listOf(1,2,3,4,5,6,7)) }
    var value by remember { mutableStateOf(true) }; var cooldown by remember { mutableStateOf("10") }
    var threshold by remember { mutableStateOf("28") }; var hysteresis by remember { mutableStateOf("1") }; var edge by remember { mutableStateOf(ThresholdEdge.Rising) }
    var actionInput by remember { mutableStateOf<String?>(null) }
    var ruleId by remember { mutableStateOf("rule-${UUID.randomUUID()}") }; var reviewed by remember { mutableStateOf<Rule?>(null) }; var simulating by remember { mutableStateOf(false) }
    var conditions by remember { mutableStateOf<List<ConditionForm>>(emptyList()) }; var preview by remember { mutableStateOf<Simulation?>(null) }; var editing by remember { mutableStateOf(false) }
    val conditionSources = ConditionEditor.sources(snapshot)
    fun reset() { ruleId = "rule-${UUID.randomUUID()}"; sourceIndex = 0; scheduled = false; scheduleTime = "22:00"; timeZone = java.time.ZoneId.systemDefault().id; weekdays = listOf(1,2,3,4,5,6,7); targetIndex = 0; value = true; actionInput = null; cooldown = "10"; threshold = "28"; hysteresis = "1"; edge = ThresholdEdge.Rising; conditions = emptyList(); reviewed = null; preview = null; editing = false }
    val scope = rememberCoroutineScope()
    val source = sources.getOrNull(sourceIndex); val target = targets.getOrNull(targetIndex)
    if (target != null) {
        Text("设置联动", fontSize = 16.sp)
        ConditionChoice("触发方式", if (scheduled) "schedule" else "device", listOf("device" to "设备事件或属性", "schedule" to "定时"), !state.busy && !simulating) { scheduled = it == "schedule" }
        if (scheduled) {
            OutlinedTextField(scheduleTime, { scheduleTime = it }, label = { Text("时间（HH:MM）") }, singleLine = true)
            OutlinedTextField(timeZone, { timeZone = it }, label = { Text("IANA 时区") }, singleLine = true)
            Text("重复", fontSize = 14.sp)
            listOf("周一","周二","周三","周四","周五","周六","周日").forEachIndexed { index, label -> Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(index + 1 in weekdays, { checked -> weekdays = if (checked) weekdays + (index + 1) else weekdays - (index + 1) }); Text(label, fontSize = 14.sp) } }
        } else { Text("当", fontSize = 14.sp); sources.forEachIndexed { index, item -> Row { RadioButton(selected = sourceIndex == index, onClick = { sourceIndex = index }); Text(item.label, fontSize = 14.sp) } } }
        source?.property?.takeUnless { scheduled }?.let { property ->
            Row { RadioButton(edge == ThresholdEdge.Rising, { edge = ThresholdEdge.Rising }); Text("上升越过", fontSize = 14.sp); RadioButton(edge == ThresholdEdge.Falling, { edge = ThresholdEdge.Falling }); Text("下降越过", fontSize = 14.sp) }
            OutlinedTextField(threshold, { threshold = it }, label = { Text("阈值（${ThresholdEditor.label(property.unit!!)}）") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            OutlinedTextField(hysteresis, { hysteresis = it }, label = { Text("滞回（${ThresholdEditor.label(property.unit!!)}）") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
        }
        Text("执行", fontSize = 14.sp); targets.forEachIndexed { index, item -> Row { RadioButton(selected = targetIndex == index, onClick = { targetIndex = index; actionInput = null }); Text(item.label, fontSize = 14.sp) } }
        if (target.type == "action.invoke") OutlinedTextField(actionInput ?: target.sample.toString(), { actionInput = it }, label = { Text("动作参数（JSON）") }, minLines = 2, maxLines = 5, modifier = Modifier.fillMaxWidth())
        else if (target.schema.type == "boolean") Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("开启设备", fontSize = 14.sp); Switch(value, { value = it }) }
        else OutlinedTextField(actionInput ?: target.sample.toString(), { actionInput = it }, label = { Text("设为") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
        OutlinedTextField(cooldown, { cooldown = it }, label = { Text("冷却时间（秒）") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
        Text("仅当", fontSize = 14.sp)
        ConditionForms(conditions, conditionSources, { conditions = it; reviewed = null; preview = null }, !state.busy && !simulating, ConditionEditor.count(conditions))
        val compiled = ConditionEditor.compile(conditions, conditionSources)
        if (compiled == null) Text("请检查条件值、组合层级和数量。每组最多16项，共32项，最多4层。", color = Amber11, fontSize = 12.sp)
        val cooldownMs = ConditionEditor.cooldown(cooldown)
        val input = if (target.type == "action.invoke") runCatching { Json.parseToJsonElement(actionInput ?: target.sample.toString()) }.getOrNull() else if (target.schema.type == "boolean") JsonPrimitive(value) else ThresholdEditor.number(actionInput ?: target.sample.toString(), target.schema)
        val property = source?.property?.takeUnless { scheduled }?.let { ThresholdEditor.property(source.event, it.unit!!, it.schema, edge, threshold, hysteresis) }
        val trigger = if (scheduled) ScheduleTrigger.fromForm(scheduleTime, timeZone, weekdays)?.let { Trigger(schedule = it) } else source?.let { if (it.property == null) Trigger(it.device, it.event) else property?.let { p -> Trigger(source.device, property = p) } }
        val sample = if (scheduled) JsonNull else source?.let { if (it.property == null) it.schema.sample() else property?.let { p -> ThresholdEditor.samples(p, source.schema) } }
        val rule = if (cooldownMs != null && compiled != null && input != null && trigger != null && sample != null) Rule(id = ruleId, trigger = trigger, conditions = compiled, actions = listOf(if (target.type == "action.invoke") Action(target.device, invoke = InvokeValue(target.path, input)) else Action(target.device, SetValue(target.path, input))), cooldownMs = cooldownMs) else null
        OutlinedButton(onClick = { if (rule != null && sample != null) { reviewed = null; preview = null; simulating = true; scope.launch { try { val result = vm.simulate(rule, sample); if (result.canDeploy) { reviewed = rule; preview = result } } catch (error: Exception) { vm.report(error) } finally { simulating = false } } } }, enabled = state.online && !state.busy && !simulating && rule != null) { Text(if (simulating) "正在预演" else "校验并预演") }
        if (!scheduled && source?.property != null) Text("预演使用示例采样，不控制设备。", color = Sand11, fontSize = 12.sp)
        if (reviewed == rule && rule != null) { Text(if (preview?.matched == true) "预演通过，设备尚未执行" else "触发样例有效，当前条件未满足。启用后等待新的触发，不会补执行。", color = Grass11, fontSize = 12.sp); preview?.conditionEvaluation?.let { ConditionEvidence(it) } }
        Button(onClick = { rule?.let(vm::deploy); reviewed = null }, enabled = state.online && !state.busy && !simulating && rule != null && reviewed == rule) { Text("启用自动化") }
        if (editing) TextButton(onClick = ::reset, enabled = !state.busy && !simulating) { Text("取消编辑") }
    } else Text("连接支持控制的设备后，可以创建联动。", fontSize = 14.sp)
    HorizontalDivider(thickness = 0.5.dp); Text("已启用", fontSize = 16.sp)
    snapshot.deployments.forEach { deployment ->
        Text(deployment.rule.trigger.schedule?.summary ?: deployment.rule.trigger.property?.summary ?: sources.firstOrNull { it.matches(deployment.rule.trigger) }?.label ?: deployment.rule.id, fontSize = 14.sp)
        deployment.rule.actions.forEach { Text("${it.device} ${it.operation.summary}", fontSize = 12.sp) }
        if (deployment.rule.conditions.isNotEmpty()) { Text("条件：全部满足", fontSize = 12.sp); ConditionEditor.rows(deployment.rule.conditions).forEach { Text(it, fontSize = 12.sp) } }
        Text("最近触发 ${deployment.lastRun ?: "尚无记录"}", fontSize = 12.sp, color = Sand11)
        val first = deployment.rule.actions.singleOrNull()
        val editable = first?.let { item -> targets.indexOfFirst { it.device == item.device && it.path == item.operation.path && it.type == item.operation.type } } ?: -1
        val trigger = sources.indexOfFirst { it.matches(deployment.rule.trigger) }
        val forms = ConditionEditor.restore(deployment.rule.conditions, conditionSources)
        if (first != null && editable >= 0 && (trigger >= 0 || deployment.rule.trigger.schedule != null) && deployment.rule.version == 1 && forms != null) OutlinedButton(onClick = { ruleId = deployment.rule.id; sourceIndex = trigger.coerceAtLeast(0); scheduled = deployment.rule.trigger.schedule != null; deployment.rule.trigger.schedule?.let { scheduleTime = it.time; timeZone = it.timeZone; weekdays = it.weekdays.toList() }; targetIndex = editable; value = first.operation.value == JsonPrimitive(true); actionInput = first.operation.value.toString(); cooldown = ConditionEditor.cooldownText(deployment.rule.cooldownMs); conditions = forms; editing = true; deployment.rule.trigger.property?.let { edge = it.edge; threshold = ThresholdEditor.display(it.threshold, it.unit); hysteresis = ThresholdEditor.display(it.hysteresis, it.unit) }; reviewed = null; preview = null }, enabled = !state.busy && !simulating) { Text("编辑") }
        OutlinedButton(onClick = { vm.stop(deployment) }, enabled = state.online && !state.busy) { Text("停用") }
    }
    TextButton(onClick = ::reset, enabled = !state.busy && !simulating) { Text("新建自动化") }
}
@Composable private fun ConditionChoice(label: String, selected: String, choices: List<Pair<String, String>>, enabled: Boolean, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }, enabled = enabled) { Text("$label：${choices.firstOrNull { it.first == selected }?.second ?: selected}", fontSize = 14.sp) }
        DropdownMenu(expanded, { expanded = false }) { choices.forEach { (value, text) -> DropdownMenuItem(text = { Text(text) }, onClick = { expanded = false; onChange(value) }) } }
    }
}
@Composable private fun ConditionForms(forms: List<ConditionForm>, sources: List<ConditionSource>, onChange: (List<ConditionForm>) -> Unit, enabled: Boolean, total: Int, depth: Int = 1, prefix: String = "") {
    forms.forEachIndexed { index, node ->
        fun replace(value: ConditionForm) { onChange(forms.mapIndexed { i, form -> if (i == index) value else form }) }
        Column(Modifier.fillMaxWidth().padding(start = if (depth == 1) 0.dp else 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val number = prefix + (index + 1)
            Text("条件 $number", fontSize = 12.sp)
            if (node.kind == "compare") {
                ConditionChoice("属性", node.source, sources.map { it.id to it.name }, enabled) { selected -> sources.firstOrNull { it.id == selected }?.let { replace(ConditionEditor.new(it)) } }
                val source = sources.firstOrNull { it.id == node.source }
                if (source != null) {
                    ConditionChoice("比较", node.comparison, ConditionEditor.operators(source.schema).map { it to ConditionEditor.label(it) }, enabled) { replace(node.copy(comparison = it)) }
                    if (source.schema.type == "boolean") ConditionChoice("比较值", node.value, listOf("true" to "是", "false" to "否"), enabled) { replace(node.copy(value = it)) }
                    else OutlinedTextField(node.value, { replace(node.copy(value = it)) }, label = { Text("比较值" + (source.unit?.let { "（${ThresholdEditor.label(it)}）" } ?: "")) }, enabled = enabled, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = if (source.schema.type in listOf("integer", "number")) KeyboardType.Decimal else KeyboardType.Text))
                }
            } else {
                ConditionChoice("组合方式", node.kind, listOf("all" to "全部满足", "any" to "任一满足"), enabled) { replace(node.copy(kind = it)) }
                ConditionForms(node.children, sources, { replace(node.copy(children = it)) }, enabled, total, depth + 1, "$number-")
            }
            TextButton(onClick = { onChange(forms.filterIndexed { i, _ -> i != index }) }, enabled = enabled) { Text("移除条件 $number") }
            HorizontalDivider(thickness = 0.5.dp)
        }
    }
    var adding by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { adding = true }, enabled = enabled && sources.isNotEmpty() && forms.size < 16 && total < 32) { Text("添加条件") }
        DropdownMenu(adding, { adding = false }) { listOf("compare" to "属性比较", "all" to "全部满足组", "any" to "任一满足组").forEach { (kind, text) -> DropdownMenuItem(text = { Text(text) }, enabled = (kind == "compare" || depth < 4) && total + (if (kind == "compare") 1 else 2) <= 32, onClick = { adding = false; sources.firstOrNull()?.let { val node = ConditionEditor.new(it); onChange(forms + if (kind == "compare") node else ConditionForm(kind = kind, children = listOf(node))) } }) } }
    }
}
@Composable private fun ConditionEvidence(evaluation: JsonElement) {
    var expanded by remember(evaluation) { mutableStateOf(false) }
    TextButton(onClick = { expanded = !expanded }) { Text("条件判断") }
    if (expanded) { ConditionEditor.evidenceRows(evaluation).forEach { Text(it, fontSize = 12.sp) }; var raw by remember(evaluation) { mutableStateOf(false) }; TextButton(onClick = { raw = !raw }) { Text("原始条件证据") }; if (raw) Text(evaluation.toString(), fontSize = 12.sp) }
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
            Text("当${name(rule.trigger.device)}${rule.trigger.summary}：", fontSize = 14.sp)
            rule.actions.forEach { action ->
                Text("${name(action.device)} ${action.operation.summary}", fontSize = 14.sp)
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
        Text(command.request.operation.summary, fontSize = 14.sp)
        Text(command.statusText, fontSize = 12.sp, color = if (command.status == "unknown") Amber11 else Sand11)
        TextButton(onClick = { expanded = !expanded }) { Text("操作详情") }
        if (expanded) { Text(command.commandId, fontSize = 12.sp); command.runId?.let { Text("关联运行 $it", fontSize = 12.sp) }; command.error?.let { Text(it, fontSize = 12.sp) } }
        HorizontalDivider(thickness = 0.5.dp)
    }
    Text("自动化运行", fontSize = 16.sp)
    state.snapshot?.runs?.forEach { run -> Text(if (run.error == "automation_budget_exceeded") "自动化操作过于频繁，本次未执行" else if (run.error == "rule_conditions_not_met") "条件未满足，本次未执行" else if (run.error != null) "运行未完成" else "${run.commandIds.size} 个关联操作", fontSize = 14.sp); Text(run.runId, fontSize = 12.sp); run.error?.let { Text(it, fontSize = 12.sp) }; run.commandIds.forEach { Text(it, fontSize = 12.sp) }; run.conditionEvaluation?.let { ConditionEvidence(it) } }
}
