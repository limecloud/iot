package run.limeai.iot.television

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.*

/** 平台Views保留API23与遥控器操作；只显示身份摘要，凭据不写进View或实例状态。 */
class TelevisionActivity : Activity() {
    private val runtime get() = (application as TelevisionApplication).runtime
    private lateinit var status: TextView
    private lateinit var details: TextView
    private lateinit var notice: TextView
    private lateinit var applications: LinearLayout
    private lateinit var start: Button
    private lateinit var stop: Button
    private lateinit var import: Button
    private lateinit var identityDetails: TextView
    private lateinit var identitySetup: Button
    private lateinit var resumeRequest: Button
    private lateinit var exportRequest: Button
    private lateinit var importCertificate: Button
    private lateinit var reopen: Button
    private lateinit var rotationDetails: TextView
    private lateinit var rotate: Button
    private lateinit var exportRotation: Button
    private lateinit var importRotation: Button
    private lateinit var recoverExpired: Button
    private lateinit var exportProof: Button
    private lateinit var importCompletion: Button
    private lateinit var retirementDetails: TextView
    private lateinit var retire: Button
    private var pendingRetirementId: String? = null
    private var pendingRotationReceipt: run.limeai.iot.device.DeviceRotationReceipt? = null
    private var lastApplications: Pair<List<AndroidApplications.Entry>, Set<String>>? = null
    private val observer: () -> Unit = { render() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(40), dp(24), dp(40), dp(32)) }
        fun label(value: String, size: Float = 18f) = TextView(this).apply { text = value; textSize = size; setPadding(0, dp(8), 0, dp(8)) }.also(content::addView)
        label(getString(R.string.app_name), 28f)
        label("使用手机或电脑控制这台电视。首次接入请核对连接配置、申请设备证书，再明确允许可启动的应用。")
        status = label("未连接", 22f); notice = label(""); details = label("尚未导入设备材料")
        fun button(value: String, action: () -> Unit) = Button(this).apply { text = value; isFocusable = true; setOnClickListener { action() } }.also(content::addView)
        identityDetails = label("尚无本机证书申请")
        identitySetup = button("导入首次连接配置") { choose("application/json", SETUP_REQUEST) }
        resumeRequest = button("恢复原申请") { runtime.requestIdentity() }
        exportRequest = button("导出原申请") {
            try { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/pkcs10").putExtra(Intent.EXTRA_TITLE, "request.csr"), EXPORT_REQUEST) }
            catch (_: ActivityNotFoundException) { runtime.notice("需要可用的系统文件选择器。") }
        }
        importCertificate = button("导入签发的设备证书") { choose("*/*", CERTIFICATE_REQUEST) }
        reopen = button("重新核对已保存记录") { runtime.reopenRecords() }
        rotationDetails = label("尚无换钥申请")
        rotate = button("申请或恢复换钥") { requestKeyChange(false) }
        recoverExpired = button("申请或恢复过期身份") { requestKeyChange(true) }
        exportRotation = button("导出原换钥申请") { createDocument("application/pkcs10", "rotation.csr", EXPORT_ROTATION) }
        importRotation = button("导入换钥回执与证书") { choose("application/json", ROTATION_RECEIPT) }
        exportProof = button("导出原激活证明") { createDocument("text/plain", "activation-proof.txt", EXPORT_PROOF) }
        importCompletion = button("核对管理端撤旧结果") { choose("application/json", ROTATION_COMPLETION) }
        retirementDetails = label("尚无可清理的旧签名键")
        retire = button("核对并清理已撤销旧密钥") {
            val available = runtime.screen.retirements.filter { it.phase in setOf("retained", "deleting") }
            AlertDialog.Builder(this).setTitle("选择原换钥操作")
                .setItems(available.map { it.requestId + if (it.phase == "deleting") "（恢复原清理）" else "（核对撤销列表）" }.toTypedArray()) { _, index ->
                    val entry = available[index]
                    if (entry.phase == "deleting") runtime.previewKeyRetirement(entry.requestId, null, ::confirmRetirement)
                    else { pendingRetirementId = entry.requestId; choose("*/*", RETIREMENT_CRL) }
                }.setNegativeButton("取消", null).show()
        }
        import = button("导入设备材料") {
            try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json"), IMPORT_REQUEST) }
            catch (_: ActivityNotFoundException) { runtime.notice("需要可用的系统文件选择器。请由所有者提供设备材料文件。") }
        }
        start = button("开始连接") { requestStart() }
        stop = button(getString(R.string.stop)) { runtime.stop(); stopService(Intent(this, AgentService::class.java)) }
        button("刷新设备与应用") { runtime.refresh() }
        label("允许启动的应用", 22f)
        label("未勾选的应用不会接受远程启动。卸载、禁用或撤销后，执行前还会重新检查。")
        applications = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also(content::addView)
        label(runtime.backgroundLimit())
        label("日志最多保留128条原命令；容量用尽时拒绝新动作。请保留原记录，不要清除应用数据恢复控制。")
        setContentView(ScrollView(this).apply { isFillViewport = true; addView(content) })
        identitySetup.requestFocus()
    }
    override fun onStart() { super.onStart(); runtime.observe(observer); runtime.refresh() }
    override fun onResume() { super.onResume(); runtime.setVisible(true) }
    override fun onPause() { runtime.setVisible(false); super.onPause() }
    override fun onStop() { runtime.remove(observer); super.onStop() }

    private fun choose(type: String, request: Int) {
        try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type), request) }
        catch (_: ActivityNotFoundException) { runtime.notice("需要可用的系统文件选择器。请由所有者提供文件。") }
    }

    private fun createDocument(type: String, name: String, request: Int) {
        try { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type).putExtra(Intent.EXTRA_TITLE, name), request) }
        catch (_: ActivityNotFoundException) { runtime.notice("需要可用的系统文件选择器。") }
    }

    private fun confirmRetirement(preview: KeyRetirementPreview) {
        if (isFinishing || isDestroyed) return
        val entry = runtime.screen.retirements.find { it.requestId == preview.requestId } ?: return
        AlertDialog.Builder(this).setTitle("确认删除原旧签名键")
            .setMessage("原换钥申请：${entry.requestId}\n旧证书：${entry.previousCertificate}\n旧公钥：${entry.previousPublicKey}\nCRL指纹：${preview.proof.fingerprint}\n\n固定CA签名及原撤销记录已核对。确认后删除该旧签名键，无法恢复；当前身份、应用授权和命令记录保留。若为中断恢复，将沿已保存的原清理决定继续。此操作不证明Broker重载或备份擦除。")
            .setNegativeButton("取消", null).setPositiveButton("确认删除该旧密钥") { _, _ -> runtime.retirePreviousKey(preview) }.show()
    }

    private fun requestStart() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST); return
        }
        try {
            val intent = Intent(this, AgentService::class.java).setAction(AgentService.ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
        } catch (_: Exception) { runtime.notice("无法开始可见连接，请检查通知权限与系统运行限制。") }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == NOTIFICATION_REQUEST) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) requestStart()
            else runtime.notice("请允许连接通知，再由本页面开始连接。")
        }
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        if (requestCode == RETIREMENT_CRL) {
            val requestId = pendingRetirementId; pendingRetirementId = null
            if (requestId == null) { runtime.notice("请重新选择原换钥操作与撤销列表。"); return }
            runtime.previewKeyRetirement(requestId, uri, ::confirmRetirement)
            return
        }
        if (requestCode == EXPORT_ROTATION || requestCode == EXPORT_PROOF) { runtime.exportRotation(uri, requestCode == EXPORT_PROOF); return }
        if (requestCode == ROTATION_RECEIPT) {
            runtime.readRotationReceipt(uri) { receipt ->
                if (isFinishing || isDestroyed) return@readRotationReceipt
                pendingRotationReceipt = receipt
                runtime.notice("已读取原签发回执，请继续选择同次签发的device.crt。")
                choose("*/*", ROTATION_CERTIFICATE)
            }
            return
        }
        if (requestCode == ROTATION_CERTIFICATE) {
            val receipt = pendingRotationReceipt; pendingRotationReceipt = null
            if (receipt == null) { runtime.notice("请重新选择原换钥回执与证书。"); return }
            runtime.readRotationCertificate(uri, receipt) { candidate ->
                if (isFinishing || isDestroyed) return@readRotationCertificate
                val summary = runtime.summary(candidate.enrollment)
                AlertDialog.Builder(this).setTitle("核对并切换新身份")
                    .setMessage("申请：${receipt.requestId}\n空间：${summary.space}\n设备：${summary.device}\n新证书：${summary.certificate}\n有效至：${summary.expires}\n\n已核对原CSR、新公钥、前证书及管理原请求摘要。保存将切换本机身份，保留授权和完整命令记录；不会自动撤旧或重载Broker。随后请导出激活证明。")
                    .setNegativeButton("取消", null).setPositiveButton("核对一致并切换") { _, _ -> runtime.activateRotation(candidate) }.show()
            }
            return
        }
        if (requestCode == ROTATION_COMPLETION) {
            runtime.readRotationReceipt(uri) { receipt ->
                if (isFinishing || isDestroyed) return@readRotationReceipt
                AlertDialog.Builder(this).setTitle("核对原管理操作结果")
                    .setMessage("申请：${receipt.requestId}\n管理端记录完成：${if (receipt.managementCompleted) "是" else "否"}\n\n只保存与原申请及当前证书一致的完成结果。此回执不证明Broker已重载或旧连接已断开；管理者仍须分别核对。")
                    .setNegativeButton("取消", null).setPositiveButton("记录原结果") { _, _ -> runtime.confirmRotationManagement(receipt) }.show()
            }
            return
        }
        if (requestCode == EXPORT_REQUEST) { runtime.exportIdentityRequest(uri); return }
        if (requestCode == SETUP_REQUEST) {
            runtime.readIdentitySetup(uri) { setup ->
                if (isFinishing || isDestroyed) return@readIdentitySetup
                AlertDialog.Builder(this).setTitle("核对首次连接配置")
                    .setMessage("空间：${setup.identity.space}\n设备：${setup.identity.device}\n连接：${setup.broker}\n逻辑模型：${setup.identity.profile.id}\n申请：${setup.requestId}\n\nCA指纹：${setup.caFingerprint}\n\n请与可信来源独立核对。确认后在本机创建并保存证书申请；已有身份须另走换钥流程。此操作不会自动连接或授权应用。")
                    .setNegativeButton("取消", null).setPositiveButton("核对一致并申请") { _, _ -> runtime.requestIdentity(setup) }.show()
            }
            return
        }
        if (requestCode == CERTIFICATE_REQUEST) {
            runtime.readIdentityCertificate(uri) { enrollment ->
                if (isFinishing || isDestroyed) return@readIdentityCertificate
                val summary = runtime.summary(enrollment)
                AlertDialog.Builder(this).setTitle("核对签发的设备证书")
                    .setMessage("空间：${summary.space}\n设备：${summary.device}\n连接：${summary.broker}\n\nCA指纹：${summary.ca}\n证书指纹：${summary.certificate}\n有效至：${summary.expires}\n\n证书已与原申请及本机密钥核对。请确认指纹来自管理者；保存不会自动连接或增加权限。")
                    .setNegativeButton("取消", null).setPositiveButton("核对一致并保存") { _, _ -> runtime.activateIdentity(enrollment) }.show()
            }
            return
        }
        if (requestCode != IMPORT_REQUEST) return
        runtime.readEnrollment(uri) { enrollment ->
            if (isFinishing || isDestroyed) return@readEnrollment
            val s = runtime.summary(enrollment)
            AlertDialog.Builder(this).setTitle("核对设备身份")
                .setMessage("空间：${s.space}\n设备：${s.device}\n连接：${s.broker}\n逻辑模型：${s.model}\n模型摘要：${s.revision}\n\nCA指纹：${s.ca}\n设备证书：${s.certificate}\n有效至：${s.expires}\n\n请逐项核对。切换遥控组合模型会保留原日志与未知记录，且不支持退回旧模型。本应用仍只执行获准的应用启动，遥控按键须由网关另行绑定。保存不会自动连接或合并ADB设备。")
                .setNegativeButton("取消", null)
                .setPositiveButton("核对一致并保存") { _, _ -> runtime.install(enrollment) }.show()
        }
    }
    private fun requestKeyChange(recovery: Boolean) {
        val original = runtime.screen.rotation
        if (original != null && (original.candidate.phase != "active" || !original.managementCompleted)) {
            if (recovery && !original.expiredRecovery && runtime.screen.summary?.expired == true && original.candidate.phase != "active") {
                AlertDialog.Builder(this).setTitle("沿原换钥申请进入过期维护")
                    .setMessage("申请：${original.candidate.setup.requestId}\n\n保留原密钥及CSR。管理端如已签发，只恢复原操作；不得更换申请或重新签发。连接和控制继续停用。")
                    .setNegativeButton("取消", null).setPositiveButton("确认维护原申请") { _, _ -> runtime.requestRotation(original.candidate.setup.requestId, true) }.show()
                return
            }
            if (original.expiredRecovery != recovery) { runtime.notice("请先恢复原申请，不能更换用途或另建申请。"); return }
            runtime.requestRotation(original.candidate.setup.requestId, recovery)
            return
        }
        val input = EditText(this).apply { hint = "唯一管理请求ID，例如tv-identity-001"; isSingleLine = true; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        AlertDialog.Builder(this).setTitle(if (recovery) "核对并申请过期恢复" else "核对并申请换钥").setView(input)
            .setMessage(if (recovery) "旧证书保持过期，连接和控制继续停用。保持原空间、设备、CA、模型、应用授权及命令记录。管理者须核对原旧证书和新公钥，签发后完成激活及撤旧。" else "保持当前空间、设备、CA和模型。暂存新键时保留原身份、应用授权和全部命令记录；切换后还须完成激活、撤旧及Broker重载。请使用唯一请求ID。")
            .setNegativeButton("取消", null).setPositiveButton("保存原申请") { _, _ -> runtime.requestRotation(input.text.toString(), recovery) }.show()
    }

    private fun render() {
        val s = runtime.screen
        val statuses = mapOf("stopped" to "已停止", "stopping" to "正在停止", "connecting" to "正在连接", "handshaking" to "正在核对设备会话", "ready" to "设备连接就绪", "connection_unavailable" to "连接失败，正在等待重连", "storage_unavailable" to "记录存储不可用，连接已阻断")
        status.text = statuses[s.status] ?: "设备未就绪（${s.status}）"
        notice.text = s.notice
        details.text = s.summary?.let { "空间：${it.space}\n设备：${it.device}\n连接：${it.broker}\n逻辑模型：${it.model}\nCA指纹：${it.ca}\n证书有效至：${it.expires}" + if (it.expired) "\n证书已过期，仅可维护" else "" } ?: "尚未导入设备材料"
        start.isEnabled = s.summary != null && !s.summary.expired && !runtime.running
        stop.isEnabled = runtime.running
        val request = s.identityRequest
        import.isEnabled = !runtime.running && request == null && s.rotation == null
        identitySetup.isEnabled = !runtime.running && s.summary == null && request == null
        resumeRequest.isEnabled = !runtime.running && request != null
        exportRequest.isEnabled = !runtime.running && request?.request != null
        importCertificate.isEnabled = !runtime.running && request?.request != null && s.summary?.expired != true
        reopen.isEnabled = !runtime.running
        val rotation = s.rotation
        rotate.isEnabled = !runtime.running && s.summary != null && !s.summary.expired
        recoverExpired.isEnabled = !runtime.running && s.summary != null && (s.summary.expired || rotation?.let { it.expiredRecovery && !it.managementCompleted } == true)
        exportRotation.isEnabled = !runtime.running && rotation?.candidate?.request != null
        importRotation.isEnabled = !runtime.running && rotation?.candidate?.request != null
        exportProof.isEnabled = !runtime.running && rotation?.candidate?.phase == "active"
        importCompletion.isEnabled = exportProof.isEnabled
        val available = s.retirements.count { it.phase in setOf("retained", "deleting") }
        val untracked = s.retirements.count { it.phase == "untracked" }
        retire.isEnabled = !runtime.running && available > 0
        retirementDetails.text = "旧签名键：$available 项可核对或恢复清理" +
            (if (untracked > 0) "\n$untracked 项较早记录缺少原键引用，保留诊断，不自动匹配删除。" else "")
        rotationDetails.text = rotation?.let {
            val phase = if (it.managementCompleted) "已记录管理完成，Broker仍需独立核对" else if (it.candidate.phase == "active") "已切换，请导出激活证明并完成撤旧" else "原身份保留，等待完成新申请"
            (if (it.expiredRecovery) "过期恢复：" else "换钥：") + "$phase\n申请：${it.candidate.setup.requestId}\n前证书序列号：${it.previousSerial}\n前证书指纹：${it.previousCertificate}" +
                (it.candidate.request?.let { csr -> "\n新公钥：${csr.publicKeyFingerprint}\n原CSR摘要：${csr.csrSha256}" } ?: "")
        } ?: "尚无换钥申请"
        identityDetails.text = request?.let {
            val phase = if (it.phase == "active") "证书已保存" else if (it.request != null) "等待签发证书" else "申请未完成，请恢复原申请"
            "证书申请：$phase\n空间：${it.setup.identity.space}\n设备：${it.setup.identity.device}\n申请：${it.setup.requestId}" +
                (it.request?.let { csr -> "\n公钥指纹：${csr.publicKeyFingerprint}\n申请摘要：${csr.csrSha256}" } ?: "")
        } ?: "尚无本机证书申请"
        val listState = s.applications to s.allowed
        if (lastApplications != listState) {
            lastApplications = listState
            applications.removeAllViews()
            val entries = (s.applications + (s.allowed - s.applications.map { it.packageName }.toSet()).map { AndroidApplications.Entry(it, "当前不可启动，可取消授权") }).sortedBy { it.packageName }
            if (entries.isEmpty()) applications.addView(TextView(this).apply { text = "尚未发现可启动的电视应用。" })
            entries.forEach { entry ->
                applications.addView(CheckBox(this).apply {
                    text = "${entry.label}\n${entry.packageName}"; textSize = 18f
                    isChecked = entry.packageName in s.allowed; isEnabled = s.summary != null && (!s.summary.expired || isChecked)
                    isFocusable = true
                    setOnCheckedChangeListener { _, checked -> runtime.authorize(entry.packageName, checked) }
                })
            }
        }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    companion object {
        private const val IMPORT_REQUEST = 41; private const val NOTIFICATION_REQUEST = 42
        private const val SETUP_REQUEST = 43; private const val EXPORT_REQUEST = 44; private const val CERTIFICATE_REQUEST = 45
        private const val EXPORT_ROTATION = 46; private const val ROTATION_RECEIPT = 47; private const val ROTATION_CERTIFICATE = 48
        private const val EXPORT_PROOF = 49; private const val ROTATION_COMPLETION = 50
        private const val RETIREMENT_CRL = 51
    }
}
