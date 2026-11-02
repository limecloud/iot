package run.limeai.iot

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.serialization.json.*
import run.limeai.iot.core.*

@Composable fun FirmwarePanel(controller: FirmwareController, devices: List<Device>, online: Boolean) {
    val state by controller.state.collectAsStateWithLifecycle()
    var material by remember { mutableStateOf("") }; var fingerprint by remember { mutableStateOf("") }; var manifest by remember { mutableStateOf("") }
    var deviceId by remember { mutableStateOf("") }; var trustId by remember { mutableStateOf("") }; var revoke by remember { mutableStateOf<FirmwareTrust?>(null) }
    val writable = state.ready && !state.busy && online
    LaunchedEffect(controller) { controller.refresh() }
    if (state.message.isNotEmpty()) Text(state.message, color = MaterialTheme.colorScheme.error, fontSize = 14.sp, modifier = Modifier.testTag("ota-message"))
    OutlinedButton(onClick = controller::refresh, enabled = !state.busy) { Text(if (state.busy) "正在读取" else "读取升级状态") }
    Text("固件信任", fontSize = 16.sp)
    OutlinedTextField(material, { material = it }, label = { Text("固件信任材料") }, minLines = 3, maxLines = 6, modifier = Modifier.fillMaxWidth().testTag("ota-trust-material"))
    OutlinedTextField(fingerprint, { fingerprint = it }, label = { Text("独立核对的固件公钥指纹") }, maxLines = 3, modifier = Modifier.fillMaxWidth().testTag("ota-trust-fingerprint"))
    Button(onClick = { val input = material; val expected = fingerprint; controller.submit { OtaChanges.trust(input, expected) } }, enabled = writable && material.isNotBlank() && fingerprint.isNotBlank()) { Text("信任固件签名者") }
    state.trusts.forEach { trust ->
        Text(if (trust.active) "已信任" else "已撤销", fontSize = 14.sp)
        Text(trust.document["trust"]!!.jsonObject["signing_key_id"]!!.jsonPrimitive.content, fontSize = 12.sp)
        FirmwareDetails("信任范围", trust.document)
        if (trust.active) TextButton(onClick = { revoke = trust }, enabled = writable) { Text("撤销固件信任") }
    }
    HorizontalDivider(thickness = 0.5.dp); Text("创建升级计划", fontSize = 16.sp)
    FirmwarePicker("升级设备", deviceId, devices.map { it.deviceId to it.deviceId }) { deviceId = it }
    FirmwarePicker("固件签名者", trustId, state.trusts.filter { it.active }.map { it.id to it.document["trust"]!!.jsonObject["signing_key_id"]!!.jsonPrimitive.content }) { trustId = it }
    OutlinedTextField(manifest, { manifest = it }, label = { Text("签名固件清单") }, minLines = 3, maxLines = 6, modifier = Modifier.fillMaxWidth().testTag("ota-manifest"))
    Button(onClick = { val d = deviceId; val t = trustId; val m = manifest; controller.submit { OtaChanges.plan(d, t, m) } }, enabled = writable && deviceId.isNotEmpty() && manifest.isNotBlank() && state.trusts.any { it.id == trustId && it.active }) { Text("创建升级计划") }
    Text("计划有效 10 分钟，批准后需另行开始安装", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    HorizontalDivider(thickness = 0.5.dp); Text("升级任务", fontSize = 16.sp)
    if (state.tasks.isEmpty()) Text("暂无升级任务", fontSize = 14.sp)
    state.tasks.forEach { task ->
        Text(task.deviceId + " → " + task.targetVersion, fontSize = 14.sp)
        Text(task.statusText, fontSize = 12.sp, modifier = Modifier.testTag("ota-task-${task.id}"))
        TextButton(onClick = { controller.review(task.id) }, enabled = writable) { Text("读取当前任务") }
    }
    state.reviewed?.let { task ->
        HorizontalDivider(thickness = 0.5.dp); Text("核对升级任务", fontSize = 16.sp)
        Text(task.deviceId + " → " + task.targetVersion, fontSize = 14.sp); Text(task.statusText, fontSize = 14.sp)
        val statement = task.document["manifest"]!!.jsonObject["statement"]!!.jsonObject
        val baseline = task.document["baseline"]!!.jsonObject["device"]!!.jsonObject
        Text("当前版本：${baseline["firmware_version"]!!.jsonPrimitive.content}", fontSize = 14.sp)
        Text("目标板卡：${statement["target"]!!.jsonObject["board"]!!.jsonPrimitive.content}", fontSize = 14.sp)
        Text("安全代次：${statement["security_epoch"]!!.jsonPrimitive.content}", fontSize = 14.sp)
        Text("镜像字节数：${statement["size_bytes"]!!.jsonPrimitive.content}", fontSize = 14.sp)
        Text(task.document["manifest_digest"]!!.jsonPrimitive.content, fontSize = 12.sp)
        Text(task.document["expires_at"]!!.jsonPrimitive.content, fontSize = 12.sp)
        FirmwareDetails("完整任务与签名清单", task.document)
        task.allowedActions.forEach { type -> Button(onClick = { controller.transition(type) }, enabled = writable, modifier = Modifier.testTag("ota-$type")) { Text(OtaChanges.labels.getValue(type)) } }
    }
    HorizontalDivider(thickness = 0.5.dp); Text("升级原操作", fontSize = 16.sp)
    state.records.asReversed().forEach { record ->
        Text(record.statusText, fontSize = 14.sp); Text(record.key, fontSize = 12.sp)
        FirmwareDetails("原请求与决定", buildJsonObject { put("request", record.request); put("result", record.result ?: JsonNull) })
        TextButton(onClick = { controller.recover(record.key) }, enabled = !state.busy) { Text("查询升级原操作") }
    }
    revoke?.let { trust -> AlertDialog(onDismissRequest = { revoke = null }, title = { Text("撤销固件信任") }, text = { Text(trust.document["trust"]!!.jsonObject["signing_key_id"]!!.jsonPrimitive.content, fontSize = 12.sp) }, confirmButton = { TextButton(onClick = { revoke = null; controller.submit { OtaChanges.revoke(trust) } }, enabled = writable) { Text("确认撤销固件信任") } }, dismissButton = { TextButton(onClick = { revoke = null }) { Text("返回") } }) }
}
@Composable private fun FirmwareDetails(label: String, value: JsonObject) {
    var expanded by remember(value) { mutableStateOf(false) }
    TextButton(onClick = { expanded = !expanded }) { Text(label) }
    if (expanded) Text(OtaJSON.canonical(value), fontSize = 12.sp)
}
@Composable private fun FirmwarePicker(label: String, selected: String, items: List<Pair<String, String>>, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }, enabled = items.isNotEmpty()) { Text(items.firstOrNull { it.first == selected }?.second ?: label, fontSize = 14.sp) }
        DropdownMenu(expanded, { expanded = false }) { items.forEach { (id, name) -> DropdownMenuItem(text = { Text(name, fontSize = 14.sp) }, onClick = { onSelect(id); expanded = false }) } }
    }
}
