package run.limeai.iot.core

import kotlinx.serialization.json.*
import java.time.Instant

class OtaException(val code: String) : Exception(code) {
    val displayMessage: String get() = when (code) {
        "ota_storage_failed", "ota_record_changed" -> "无法保存或读取本机升级记录，请检查安全存储"
        "ota_pending_operation" -> "请先查询同一设备或任务的原操作"
        "ota_capacity" -> "本机升级记录已满"
        "ota_fingerprint_mismatch" -> "公钥指纹与独立核对值不一致"
        "ota_unknown" -> "结果未知，请查询升级原操作"
        "ota_busy" -> "已有升级操作正在处理"
        else -> "升级材料或响应未通过校验"
    }
}

// OTA 合同只含安全整数。严格边界与摘要用于绑定原请求，验签及设备策略由 Rust 执行。
object OtaJSON {
    private fun fail(): Nothing = throw OtaException("invalid_ota_document")
    fun parse(text: String, response: Boolean = false): JsonObject = try { IntegerJSON.parse(text, if (response) 2_000_000 else 16384, if (response) 24 else 16, if (response) 65536 else 2048) } catch (error: Exception) { fail() }
    fun canonical(value: JsonElement): String = IntegerJSON.canonical(value)
    fun digest(value: JsonElement): String = IntegerJSON.digest(value)
    internal fun fields(o: JsonObject, names: String) { if (o.keys != names.split(',').toSet()) fail() }
    internal fun obj(v: JsonElement?): JsonObject = v as? JsonObject ?: fail()
    internal fun str(v: JsonElement?): String = (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: fail()
    internal fun text(o: JsonObject, key: String) = str(o[key])
    internal fun id(v: JsonElement?, prefix: String = ""): String = str(v).also { if (!it.matches(Regex("[A-Za-z0-9_-]{1,128}")) || !it.startsWith(prefix)) fail() }
    internal fun hex(v: JsonElement?, prefix: String = "sha256:"): String = str(v).also { if (!it.matches(Regex(Regex.escape(prefix) + "[a-f0-9]{64}"))) fail() }
    internal fun time(v: JsonElement?): Instant = runCatching { Instant.parse(str(v)) }.getOrElse { fail() }
    internal fun bool(v: JsonElement?): Boolean = (v as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: fail()
    internal fun integer(v: JsonElement?): Long = (v as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it in 0..9007199254740991L } ?: fail()
    internal fun require(value: Boolean) { if (!value) fail() }
    internal fun reason(v: JsonElement?) { if (v != JsonNull && !str(v).matches(Regex("[a-z][a-z0-9_]{0,63}"))) fail() }
    fun change(text: String): JsonObject = parse(text).also(::change)
    internal fun change(v: JsonObject) {
        when (text(v, "type")) {
            "trust.add" -> { fields(v, "type,trust,expected_signing_key_id"); obj(v["trust"]); hex(v["expected_signing_key_id"]) }
            "trust.revoke" -> { fields(v, "type,trust_id,expected_revision"); hex(v["trust_id"], "fwtrust-"); id(v["expected_revision"]) }
            "tasks.plan" -> { fields(v, "type,device_id,trust_id,manifest,expires_at"); id(v["device_id"]); hex(v["trust_id"], "fwtrust-"); obj(v["manifest"]); time(v["expires_at"]) }
            "tasks.approve", "tasks.execute", "tasks.reconcile", "tasks.cancel" -> { fields(v, "type,task_id,expected_revision"); id(v["task_id"], "ota-"); id(v["expected_revision"]) }
            else -> fail()
        }
    }
    internal fun operation(v: JsonObject, expected: JsonObject) {
        fields(v, "operation_id,request,request_digest,status,reason,resource,created_at")
        id(v["operation_id"], "otaop-"); time(v["created_at"])
        require(v["request"] == expected && v["request_digest"] == JsonPrimitive(digest(expected)))
        val status = text(v, "status"); val change = obj(expected["change"]); val type = text(change, "type")
        if (status != "applied") {
            require(status in listOf("rejected", "conflict") && v["resource"] == JsonNull && v["reason"] != JsonNull)
            reason(v["reason"]); require((status == "conflict") == (v["reason"] == JsonPrimitive("revision_conflict"))); return
        }
        require(v["reason"] == JsonNull)
        val resource = obj(v["resource"]); fields(resource, "kind,id,revision"); id(resource["revision"])
        if (type.startsWith("trust.")) {
            require(text(resource, "kind") == "firmware_trust"); hex(resource["id"], "fwtrust-")
            if (type == "trust.add") require(text(resource, "id") == "fwtrust-" + digest(change.getValue("trust")).removePrefix("sha256:") && change["expected_signing_key_id"] == obj(change["trust"])["signing_key_id"])
            else require(resource["id"] == change["trust_id"])
        } else {
            require(text(resource, "kind") == "ota_task"); id(resource["id"], "ota-")
            if (type != "tasks.plan") require(resource["id"] == change["task_id"])
        }
    }
    internal fun trust(v: JsonObject) {
        fields(v, "trust_id,revision,trust,active,created_at,revoked_at"); id(v["revision"])
        val trust = obj(v["trust"])
        fields(trust, "schema,version,purpose,signing_key_id,public_key,product_ids,download_origins,minimum_security_epoch,minimum_battery_percent,revoked_artifact_ids,not_before,expires_at")
        require(trust["schema"] == JsonPrimitive("limeiot.ota-trust") && trust["version"] == JsonPrimitive(1) && trust["purpose"] == JsonPrimitive("device-firmware"))
        hex(trust["signing_key_id"]); str(trust["public_key"])
        for (key in listOf("product_ids", "download_origins", "revoked_artifact_ids")) {
            val values = trust[key] as? JsonArray ?: fail(); values.forEach { str(it) }; require(values.size <= 128 && values.distinct().size == values.size)
            if (key != "revoked_artifact_ids") require(values.isNotEmpty())
        }
        integer(trust["minimum_security_epoch"]); require(integer(trust["minimum_battery_percent"]) <= 100)
        require(time(trust["expires_at"]) > time(trust["not_before"]))
        require(text(v, "trust_id") == "fwtrust-" + digest(trust).removePrefix("sha256:"))
        require(bool(v["active"]) == (v["revoked_at"] == JsonNull))
        val created = time(v["created_at"]); if (!bool(v["active"])) require(time(v["revoked_at"]) >= created)
    }
    internal fun info(v: JsonObject, device: JsonElement?) {
        fields(v, "device,boot_id,session_id,seq,received_at"); id(v["boot_id"]); id(v["session_id"]); integer(v["seq"]); time(v["received_at"])
        val d = obj(v["device"])
        fields(d, "device_id,product_id,architecture,chip,board,hardware_revision,firmware_version,bootloader_version,protocol_version,model_revision,security_epoch,ota_capacity_bytes,external_power,battery_percent,safe_to_update,pending_update")
        require(d["device_id"] == device && d["protocol_version"] == JsonPrimitive(1)); hex(d["model_revision"])
        listOf("product_id", "architecture", "chip", "board", "hardware_revision", "firmware_version", "bootloader_version").forEach { str(d[it]) }
        listOf("external_power", "safe_to_update", "pending_update").forEach { bool(d[it]) }
        integer(d["security_epoch"]); integer(d["ota_capacity_bytes"])
        if (d["battery_percent"] != JsonNull) require(integer(d["battery_percent"]) <= 100)
    }
    private fun manifest(v: JsonObject) {
        fields(v, "schema,version,algorithm,signing_key_id,statement,signature")
        require(v["schema"] == JsonPrimitive("limeiot.ota-manifest") && v["version"] == JsonPrimitive(1) && v["algorithm"] == JsonPrimitive("Ed25519")); hex(v["signing_key_id"]); str(v["signature"])
        val s = obj(v["statement"]); fields(s, "artifact_id,kind,target,version,compatibility,size_bytes,sha256,security_epoch,download,issued_at,expires_at")
        hex(s["artifact_id"], "artifact-"); require(s["kind"] == JsonPrimitive("device-firmware")); str(s["version"]); hex(s["sha256"]); integer(s["security_epoch"]); require(integer(s["size_bytes"]) in 1..33554432)
        require(time(s["expires_at"]) > time(s["issued_at"]))
        val t = obj(s["target"]); fields(t, "product_id,architecture,chip,board,hardware_revisions")
        listOf("product_id", "architecture", "chip", "board").forEach { str(t[it]) }
        val c = obj(s["compatibility"]); fields(c, "protocol_version,model_revisions,minimum_bootloader_version,from_versions"); require(c["protocol_version"] == JsonPrimitive(1)); str(c["minimum_bootloader_version"])
        for (values in listOf(t["hardware_revisions"], c["model_revisions"], c["from_versions"])) { val items = values as? JsonArray ?: fail(); require(items.size in 1..16); items.forEach { str(it) } }
        val d = obj(s["download"]); fields(d, "url,redirects"); str(d["url"]); require(d["redirects"] == JsonPrimitive(false))
    }
    internal fun task(v: JsonObject) {
        fields(v, "task_id,revision,device_id,trust_id,trust_revision,manifest,manifest_digest,baseline,created_at,expires_at,status,approval,execution,reason")
        id(v["task_id"], "ota-"); id(v["revision"]); id(v["device_id"]); hex(v["trust_id"], "fwtrust-"); id(v["trust_revision"])
        val manifest = obj(v["manifest"]); manifest(manifest); require(v["manifest_digest"] == JsonPrimitive(digest(manifest)))
        require(time(v["expires_at"]) > time(v["created_at"])); reason(v["reason"])
        val status = text(v, "status"); require(status in OtaTask.statuses.keys)
        info(obj(v["baseline"]), v["device_id"])
        require((status == "approved" || v["execution"] != JsonNull) == (v["approval"] != JsonNull))
        if (v["approval"] != JsonNull) { val a = obj(v["approval"]); fields(a, "approved_at,device_info"); time(a["approved_at"]); info(obj(a["device_info"]), v["device_id"]) }
        execution(v)
    }
    private fun envelope(v: JsonObject, kind: String, task: JsonObject, upstream: Boolean = false) {
        fields(v, "v,kind,message_id,device_id,model_revision,boot_id,session_id,body" + if (upstream) ",seq" else "")
        require(v["v"] == JsonPrimitive(1) && v["kind"] == JsonPrimitive(kind) && v["device_id"] == task["device_id"] && v["model_revision"] == obj(obj(task["baseline"])["device"])["model_revision"])
        id(v["message_id"]); id(v["boot_id"]); id(v["session_id"]); obj(v["body"]); if (upstream) integer(v["seq"])
    }
    private fun execution(t: JsonObject) {
        val status = text(t, "status")
        if (t["execution"] == JsonNull) { require(status !in listOf("executing", "unknown", "succeeded", "failed")); return }
        require(status in listOf("executing", "unknown", "succeeded", "failed"))
        val x = obj(t["execution"]); fields(x, "envelope,request_digest,prepared_at,attempted_at,receipt,query,query_count")
        val approval = obj(t["approval"]); val prepared = time(x["prepared_at"])
        require(prepared >= time(approval["approved_at"]) && prepared < time(t["expires_at"]))
        if (x["attempted_at"] != JsonNull) require(time(x["attempted_at"]) >= prepared && time(x["attempted_at"]) < time(t["expires_at"]))
        require(integer(x["query_count"]) <= 32 && (integer(x["query_count"]) > 0) == (x["query"] != JsonNull))
        val install = obj(x["envelope"]); envelope(install, "ota_install", t)
        val body = obj(install["body"]); fields(body, "task_id,execution_id,manifest_digest,manifest,expires_at")
        val approvedInfo = obj(approval["device_info"])
        require(x["request_digest"] == JsonPrimitive(digest(install)) && install["boot_id"] == approvedInfo["boot_id"] && install["session_id"] == approvedInfo["session_id"])
        id(body["execution_id"], "otaexec-")
        require(body["task_id"] == t["task_id"] && body["manifest_digest"] == t["manifest_digest"] && body["manifest"] == t["manifest"] && body["expires_at"] == t["expires_at"] && (status != "unknown" || x["attempted_at"] != JsonNull))
        if (x["receipt"] != JsonNull) {
            val receipt = obj(x["receipt"]); fields(receipt, "envelope,received_at")
            require(x["attempted_at"] != JsonNull && time(receipt["received_at"]) >= time(x["attempted_at"]))
            val report = obj(receipt["envelope"]); envelope(report, "ota_result", t, true)
            val r = obj(report["body"]); fields(r, "task_id,execution_id,request_digest,manifest_digest,status,firmware_version,security_epoch,image_sha256,pending_update,error")
            val rs = text(r, "status"); val success = rs == "succeeded"; val failed = rs in listOf("rejected", "failed", "rolled_back")
            require(rs in listOf("installing", "awaiting_boot", "succeeded", "rejected", "failed", "rolled_back"))
            require(r["task_id"] == t["task_id"] && r["execution_id"] == body["execution_id"] && r["request_digest"] == x["request_digest"] && r["manifest_digest"] == t["manifest_digest"])
            hex(r["image_sha256"]); require(r["pending_update"] == JsonPrimitive(false) && failed == (r["error"] != JsonNull)); reason(r["error"])
            val expected = if (success) obj(obj(t["manifest"])["statement"]) else obj(obj(t["baseline"])["device"])
            require(r["firmware_version"] == expected[if (success) "version" else "firmware_version"] && r["security_epoch"] == expected["security_epoch"])
            if (success) require(r["image_sha256"] == expected["sha256"] && report["boot_id"] != install["boot_id"])
            if (rs == "rolled_back") require(report["boot_id"] != install["boot_id"])
            if (!success && !failed) require(report["boot_id"] == install["boot_id"])
            require(status == (if (success) "succeeded" else if (failed) "failed" else "executing") || (status == "unknown" && !success && !failed))
        } else require(status != "succeeded" && !(status == "failed" && x["attempted_at"] != JsonNull))
        if (x["query"] != JsonNull) {
            val q = obj(x["query"]); fields(q, "envelope,prepared_at,attempted"); bool(q["attempted"])
            require(x["attempted_at"] != JsonNull && time(q["prepared_at"]) >= time(x["attempted_at"]))
            val e = obj(q["envelope"]); envelope(e, "ota_query", t); val b = obj(e["body"]); fields(b, "task_id,execution_id,request_digest,manifest_digest,expires_at")
            require(b["task_id"] == t["task_id"] && b["execution_id"] == body["execution_id"] && b["request_digest"] == x["request_digest"] && b["manifest_digest"] == t["manifest_digest"] && time(b["expires_at"]) == time(q["prepared_at"]).plusSeconds(30))
        }
    }
}

@ConsistentCopyVisibility
data class OtaTask internal constructor(val document: JsonObject) {
    val id get() = OtaJSON.text(document, "task_id")
    val revision get() = OtaJSON.text(document, "revision")
    val deviceId get() = OtaJSON.text(document, "device_id")
    val status get() = OtaJSON.text(document, "status")
    val statusText get() = statuses.getValue(status)
    val targetVersion get() = document["manifest"]?.jsonObject?.get("statement")?.jsonObject?.get("version")?.jsonPrimitive?.content.orEmpty()
    val allowedActions get() = when (status) { "planned" -> listOf("tasks.approve", "tasks.cancel"); "approved" -> listOf("tasks.execute", "tasks.cancel"); "executing", "unknown" -> if (document["execution"]?.jsonObject?.get("query_count")?.jsonPrimitive?.intOrNull?.let { it < 32 } == true) listOf("tasks.reconcile") else emptyList(); else -> emptyList() }
    companion object { internal val statuses = mapOf("planned" to "待批准", "approved" to "已批准，尚未安装", "executing" to "正在安装", "unknown" to "结果未知", "succeeded" to "升级成功", "failed" to "升级失败", "cancelled" to "已取消", "expired" to "已过期", "invalidated" to "已失效") }
}
@ConsistentCopyVisibility
data class FirmwareTrust internal constructor(val document: JsonObject) {
    val id get() = OtaJSON.text(document, "trust_id")
    val revision get() = OtaJSON.text(document, "revision")
    val active get() = OtaJSON.bool(document["active"])
}
@ConsistentCopyVisibility
data class OtaRecord internal constructor(val request: JsonObject, val result: JsonObject?) {
    val key get() = OtaJSON.text(request, "idempotency_key")
    val type get() = OtaJSON.text(OtaJSON.obj(request["change"]), "type")
    val statusText get() = result?.let { when (OtaJSON.text(it, "status")) { "applied" -> "决定已保存"; "rejected" -> "操作已拒绝"; else -> "修订冲突" } } ?: "结果未知"
}

object OtaChanges {
    val labels = mapOf("tasks.approve" to "批准升级", "tasks.execute" to "开始安装", "tasks.reconcile" to "查询设备结果", "tasks.cancel" to "取消计划")
    fun trust(material: String, fingerprint: String) = buildJsonObject { put("type", "trust.add"); put("trust", OtaJSON.parse(material)); put("expected_signing_key_id", fingerprint.trim()) }.also { OtaJSON.change(it) }
    fun plan(deviceId: String, trustId: String, manifest: String, now: Instant = Instant.now()) = buildJsonObject { put("type", "tasks.plan"); put("device_id", deviceId); put("trust_id", trustId); put("manifest", OtaJSON.parse(manifest)); put("expires_at", now.plusSeconds(600).toString()) }.also { OtaJSON.change(it) }
    fun transition(task: OtaTask, type: String): JsonObject {
        OtaJSON.require(type in task.allowedActions)
        return buildJsonObject { put("type", type); put("task_id", task.id); put("expected_revision", task.revision) }
    }
    fun revoke(trust: FirmwareTrust) = buildJsonObject { put("type", "trust.revoke"); put("trust_id", trust.id); put("expected_revision", trust.revision) }
}
