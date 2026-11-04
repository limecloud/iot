package run.limeai.iot

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.BorderStroke
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
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.*
import run.limeai.iot.core.*

private val titles = mapOf(AiCapability.RULE_DRAFT to "联动草案", AiCapability.TEXT to "文字对话", AiCapability.VISION to "图片观察", AiCapability.TRANSCRIPTION to "语音识别", AiCapability.SPEECH to "语音合成")
private val configurationLabels = mapOf("concurrency" to "并发任务", "max_output_tokens" to "输出 Token 上限", "max_messages" to "消息数上限", "max_context_bytes" to "上下文字节上限", "max_instructions_characters" to "指令字数上限", "max_text_bytes" to "文字字节上限", "max_characters" to "文字字数上限", "max_deadline_seconds" to "期限上限（秒）", "max_retain_seconds" to "保留上限（秒）", "streaming" to "流式输出", "provider_cancellation" to "提供方取消", "input_storage" to "输入保存方式", "server_memory" to "服务端记忆", "device_execution" to "直接执行设备操作", "content_types" to "图片格式", "max_image_bytes" to "图片字节上限", "max_edge" to "图片边长上限（像素）", "max_prompt_characters" to "问题字数上限", "languages" to "识别语言", "max_audio_bytes" to "音频字节上限", "max_audio_seconds" to "音频时长上限（秒）", "voices" to "声音编号", "max_output_bytes" to "输出字节上限")
private fun display(value: JsonElement): String = when (value) {
    is JsonArray -> value.joinToString("、") { display(it) }
    is JsonPrimitive -> when { value == JsonNull -> "未记录"; value.booleanOrNull != null && !value.isString -> if (value.boolean) "支持" else "不支持"; value.content == "digest_only" -> "仅摘要"; else -> value.content }
    else -> value.toString()
}
@Composable fun AiCatalogPanel(vm: HomeViewModel, context: String, online: Boolean, open: (AiCapability) -> Unit) {
    val scope = rememberCoroutineScope()
    val controller = remember(vm, context) { AiCatalogController(vm::aiCatalog, scope, vm::report) }
    val state by controller.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(controller, online, lifecycle) {
        controller.setOnline(online)
        if (!online) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            try { controller.refresh(); awaitCancellation() } finally { controller.pause() }
        }
    }
    DisposableEffect(controller) { onDispose { controller.close() } }
    OutlinedButton(onClick = controller::refresh, enabled = online && !state.busy, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline), modifier = Modifier.testTag("ai-catalog-refresh")) { Text("读取 AI 服务") }
    if (state.catalog == null) Text(if (!online) "网关离线，重新连接后可查询服务" else state.message.ifEmpty { "正在读取 AI 服务" }, fontSize = 14.sp)
    state.catalog?.entries?.forEach { entry ->
        Column(Modifier.fillMaxWidth().testTag("ai-catalog-${entry.capability.id}"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(titles.getValue(entry.capability), fontSize = 16.sp)
            Text(if (entry.configured) "已配置，健康未检测" else "未配置", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            entry.model?.let { Text(it, fontSize = 14.sp) }
            if (entry.configured) TextButton(onClick = { if (online && controller.state.value.catalog === state.catalog) open(entry.capability) }, enabled = online && !state.busy, modifier = Modifier.testTag("ai-catalog-open-${entry.capability.id}")) { Text("打开${titles.getValue(entry.capability)}") }
            var details by remember(entry.capability) { mutableStateOf(false) }
            TextButton(onClick = { details = !details }) { Text("能力详情") }
            if (details) {
                Text("能力编号：${entry.capability.id}", fontSize = 12.sp)
                for ((key, label) in listOf("create_operation" to "创建操作", "resolve_operation" to "恢复操作", "input_schema" to "输入合同", "task_schema" to "任务合同")) Text("$label：${entry.definition[key]?.takeUnless { it == JsonNull }?.let(::display) ?: "未提供机器 Schema"}", fontSize = 12.sp)
                Text("设备执行：须独立审核与授权", fontSize = 12.sp)
                if (entry.configured) {
                    Text("部署修订：${entry.revision ?: "未记录"}", fontSize = 12.sp)
                    Text("数据位置：本地", fontSize = 12.sp)
                    entry.configuration?.forEach { (key, value) -> Text("${configurationLabels[key] ?: key}：${display(value)}", fontSize = 12.sp) }
                    Text("模型许可：未核验\n费用政策：未登记\n资源需求：未登记\n效果质量：未核验", fontSize = 12.sp)
                }
            }
        }
    }
}
