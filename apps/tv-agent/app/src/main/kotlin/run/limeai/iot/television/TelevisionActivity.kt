package run.limeai.iot.television

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.*
import run.limeai.iot.device.DeviceModelProfile

/** 平台Views保留API23与遥控器操作；只显示身份摘要，凭据不写进View或实例状态。 */
class TelevisionActivity : Activity() {
    private val runtime get() = (application as TelevisionApplication).runtime
    private lateinit var status: TextView
    private lateinit var details: TextView
    private lateinit var applications: LinearLayout
    private lateinit var start: Button
    private lateinit var stop: Button
    private lateinit var audioStatus: TextView
    private lateinit var revokeAudio: Button
    private lateinit var navigation: TvNavigation
    private lateinit var backNavigation: TvBackNavigation
    private lateinit var heroTitle: TextView
    private lateinit var heroMessage: TextView
    private lateinit var homeSetup: Button
    private lateinit var applicationsSummary: TextView
    private lateinit var capabilitiesSummary: TextView
    private lateinit var homeConnectionSummary: TextView
    private lateinit var connectionStep: TextView
    private lateinit var connectionSummary: TextView
    private lateinit var maintenanceSummary: TextView
    private var audioDialog: AlertDialog? = null
    private var modelDialog: AlertDialog? = null
    private lateinit var modelAssignment: Button
    private var resumed = false
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
        backNavigation = TvBackNavigation(this, ::returnToOverview)
        navigation = TvNavigation(this) { backNavigation.update(it != HOME) }
        fun label(parent: LinearLayout, value: String, size: Float = 16f, secondary: Boolean = true) =
            TvUi.label(this, value, size, secondary).also { view ->
                parent.addView(view, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) })
            }
        fun button(parent: LinearLayout, value: String, primary: Boolean = false, action: () -> Unit) =
            TvUi.button(this, value, primary, action).also(parent::addView)
        fun panel(parent: LinearLayout, title: String, description: String): LinearLayout = TvUi.card(this).also {
            parent.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(16) })
            label(it, title, 20f, false); label(it, description, 15f)
        }

        val home = TvUi.column(this)
        val hero = TvUi.column(this).apply { setPadding(dp(12), dp(18), 0, 0); minimumHeight = dp(218) }
        home.addView(hero)
        status = label(hero, "连接状态", 13f)
        heroTitle = label(hero, "这台电视", 40f, false)
        heroMessage = label(hero, "连接家庭网关，允许手机和电脑控制这台电视。", 16f).apply { maxWidth = dp(560) }
        homeSetup = button(hero, "设置连接", true) { navigation.show(CONNECTION, true) }.apply {
            layoutParams = LinearLayout.LayoutParams(dp(184), -2).apply { topMargin = dp(12) }
        }
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; clipChildren = false }
        hero.addView(actions)
        start = button(actions, "开始连接", true) { requestStart() }.apply {
            layoutParams = LinearLayout.LayoutParams(dp(184), -2).apply { topMargin = dp(12); rightMargin = dp(12) }
        }
        stop = button(actions, getString(R.string.stop)) { runtime.stop(); stopService(Intent(this, AgentService::class.java)) }.apply {
            layoutParams = LinearLayout.LayoutParams(dp(164), -2).apply { topMargin = dp(12) }
        }
        home.addView(TvUi.space(this, 18))
        val shortcuts = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; clipChildren = false }
        home.addView(shortcuts, LinearLayout.LayoutParams(-1, dp(110)))
        applicationsSummary = TvUi.actionTile(shortcuts, R.drawable.ic_tv_apps, "应用授权", "选择允许远程启动的应用") { navigation.show(APPLICATIONS, true) }
        homeConnectionSummary = TvUi.actionTile(shortcuts, R.drawable.ic_tv_connection, "连接设置", "接入你的家庭网关") { navigation.show(CONNECTION, true) }
        capabilitiesSummary = TvUi.actionTile(shortcuts, R.drawable.ic_tv_maintenance, "设备维护", "管理能力与应用更新") { navigation.show(MAINTENANCE, true) }
        navigation.addPage("总览", "这台电视", "管理连接、应用授权与设备维护。", home)

        val connection = TvUi.column(this)
        val setup = panel(connection, "连接家庭网关", "由家庭网关的管理者准备连接配置，在电视上核对并完成接入。")
        connectionStep = label(setup, "第一步 · 导入连接配置", 18f, false)
        identitySetup = button(setup, "导入首次连接配置", true) { choose("application/json", SETUP_REQUEST) }
        resumeRequest = button(setup, "恢复原申请") { runtime.requestIdentity() }
        exportRequest = button(setup, "导出原申请") {
            try { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/pkcs10").putExtra(Intent.EXTRA_TITLE, "request.csr"), EXPORT_REQUEST) }
            catch (_: ActivityNotFoundException) { runtime.notice("需要可用的系统文件选择器。") }
        }
        importCertificate = button(setup, "导入签发的设备证书") { choose("*/*", CERTIFICATE_REQUEST) }
        connectionSummary = label(setup, "连接配置只保存在这台电视中。", 15f)
        button(setup, "查看完整身份信息") { navigation.show(DIAGNOSTICS, true) }
        val legacy = panel(connection, "已有设备材料？", "如果管理者已提供完整的设备材料，可从这里导入并逐项核对。")
        import = button(legacy, "导入设备材料") {
            try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json"), IMPORT_REQUEST) }
            catch (_: ActivityNotFoundException) { runtime.notice("需要可用的系统文件选择器。请由所有者提供设备材料文件。") }
        }
        navigation.addPage("连接设置", "连接设置", "接入家庭网关，由你决定何时开始连接。", connection)

        val apps = TvUi.column(this)
        label(apps, "只有你允许的应用，才能从手机或电脑远程启动。随时取消，立即生效。", 16f)
        applications = TvUi.column(this)
        apps.addView(applications)
        button(apps, "刷新设备与应用") { runtime.refresh() }
        navigation.addPage("应用授权", "应用授权", "使用方向键选择应用，按确定键允许或取消。", apps)

        val maintenance = TvUi.column(this)
        val capabilities = panel(maintenance, "设备能力", "应用启动、音量与外部遥控分别授权，按当前配置提供。")
        maintenanceSummary = label(capabilities, "尚未配置设备能力", 18f, false)
        modelAssignment = button(capabilities, "扩展设备能力配置") { chooseModelAssignment() }
        audioStatus = label(capabilities, "尚未允许音量和静音控制", 15f)
        revokeAudio = button(capabilities, "取消本次音量和静音授权并停止") { runtime.revokeAudio(); stopService(Intent(this, AgentService::class.java)) }
        val updates = panel(maintenance, "应用更新", "核对发布材料与权限变化，由你明确批准每次更新。")
        button(updates, "更新材料与批准") { startActivity(Intent(this, ApkUpdateActivity::class.java)) }
        val security = panel(maintenance, "设备身份管理", "仅在更换证书、证书过期或清理旧密钥时使用。请先停止连接。")
        val advanced = TvUi.column(this).apply { visibility = View.GONE }
        button(security, "证书与密钥管理") {
            advanced.visibility = if (advanced.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        security.addView(advanced)
        rotate = button(advanced, "申请或恢复换钥") { requestKeyChange(false) }
        recoverExpired = button(advanced, "申请或恢复过期身份") { requestKeyChange(true) }
        exportRotation = button(advanced, "导出原换钥申请") { createDocument("application/pkcs10", "rotation.csr", EXPORT_ROTATION) }
        importRotation = button(advanced, "导入换钥回执与证书") { choose("application/json", ROTATION_RECEIPT) }
        exportProof = button(advanced, "导出原激活证明") { createDocument("text/plain", "activation-proof.txt", EXPORT_PROOF) }
        importCompletion = button(advanced, "核对管理端撤旧结果") { choose("application/json", ROTATION_COMPLETION) }
        retire = button(advanced, "核对并清理已撤销旧密钥") {
            val available = runtime.screen.retirements.filter { it.phase in setOf("retained", "deleting") }
            AlertDialog.Builder(this).setTitle("选择原换钥操作")
                .setItems(available.map { it.requestId + if (it.phase == "deleting") "（恢复原清理）" else "（核对撤销列表）" }.toTypedArray()) { _, index ->
                    val entry = available[index]
                    if (entry.phase == "deleting") runtime.previewKeyRetirement(entry.requestId, null, ::confirmRetirement)
                    else { pendingRetirementId = entry.requestId; choose("*/*", RETIREMENT_CRL) }
                }.setNegativeButton("取消", null).show()
        }
        navigation.addPage("设备维护", "设备维护", "管理设备能力、应用更新与证书。", maintenance)

        val diagnostics = TvUi.column(this)
        val information = panel(diagnostics, "设备与连接信息", "这里的摘要可用于与家庭网关管理者核对，不包含私钥。")
        details = label(information, "尚未导入设备材料", 15f)
        identityDetails = label(information, "尚无本机证书申请", 14f)
        rotationDetails = label(information, "尚无换钥申请", 14f)
        retirementDetails = label(information, "尚无可清理的旧签名键", 14f)
        reopen = button(information, "重新核对已保存记录") { runtime.reopenRecords() }
        val help = panel(diagnostics, "使用与恢复", runtime.backgroundLimit())
        label(help, "连接失败时请检查网关地址与网络。证书过期请进入设备维护；存储异常请保留原记录并重新核对。", 15f)
        label(help, "不要通过清除应用数据恢复控制；这会丢失设备身份、授权与原命令记录。", 15f)
        label(help, "LimeIoT ${BuildConfig.VERSION_NAME}  ·  Android ${Build.VERSION.RELEASE}", 13f)
        navigation.addPage("诊断信息", "诊断信息", "查看连接信息，核对设备记录。", diagnostics)
        setContentView(navigation.root)
        navigation.show(savedInstanceState?.getInt("page", HOME) ?: HOME)
        navigation.focusNavigation()
    }
    override fun onStart() { super.onStart(); runtime.observe(observer); runtime.refresh() }
    override fun onResume() { super.onResume(); resumed = true; runtime.setVisible(true) }
    override fun onPause() {
        resumed = false
        runtime.setVisible(false)
        audioDialog?.dismiss(); audioDialog = null
        modelDialog?.dismiss(); modelDialog = null
        super.onPause()
    }
    override fun onStop() { runtime.remove(observer); super.onStop() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("page", navigation.selected)
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() { backNavigation.close(); super.onDestroy() }
    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (Build.VERSION.SDK_INT < 33 && keyCode == KeyEvent.KEYCODE_BACK && !event.isCanceled && navigation.selected != HOME) {
            returnToOverview(); return true
        }
        return super.onKeyUp(keyCode, event)
    }
    private fun returnToOverview() { navigation.show(HOME); navigation.focusNavigation() }

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

    private fun modelLabel(profile: DeviceModelProfile): String = when (profile) {
        DeviceModelProfile.APPLICATIONS -> "应用启动"
        DeviceModelProfile.COMPOSED_REMOTE -> "应用启动与外部遥控"
        DeviceModelProfile.AUDIO_APPLICATIONS -> "应用启动、音量与静音"
        DeviceModelProfile.AUDIO_COMPOSED_REMOTE -> "应用启动、音量、静音与外部遥控"
    }

    private fun chooseModelAssignment() {
        if (!resumed) return
        val current = runtime.screen.summary?.let { DeviceModelProfile.parse(it.model) } ?: return
        val choices = DeviceModelProfile.values().filter { it != current && it.acceptsHistory(current) }
        if (choices.isEmpty()) return
        modelDialog?.dismiss()
        modelDialog = AlertDialog.Builder(this).setTitle("选择扩展后的设备能力")
            .setItems(choices.map(::modelLabel).toTypedArray()) { _, index ->
                if (!resumed) return@setItems
                runtime.previewModelAssignment(choices[index]) { result ->
                    result.fold({ review ->
                        if (!resumed || isFinishing || isDestroyed || !review.foreground.active) return@fold
                        val preview = review.preview
                        var confirmed = false
                        val dialog = AlertDialog.Builder(this).setTitle("确认扩展设备能力")
                            .setMessage("空间：${preview.identity.space}\n设备：${preview.identity.device}\n当前：${modelLabel(preview.identity.profile)}\n目标：${modelLabel(preview.target)}\n证书：${preview.certificate}\n\n保留原设备身份、证书、申请、命令记录和应用授权。外部遥控还需管理者明确配置执行组合；音量与静音在每次连接前另行允许。保存后可继续扩展，不能回退移除已有能力。")
                            .setNegativeButton("取消", null)
                            .setPositiveButton("确认保存能力配置", null)
                            .create()
                        modelDialog = dialog
                        dialog.setOnDismissListener {
                            if (!confirmed) runtime.cancelModelAssignment(review)
                            if (modelDialog === dialog) modelDialog = null
                        }
                        dialog.show()
                        // 在系统dismiss回调前同步决定消费或取消，避免排队按钮消息越过取消。
                        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener {
                            runtime.cancelModelAssignment(review); dialog.dismiss()
                        }
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                            confirmed = true; runtime.approveModelAssignment(review) {}; dialog.dismiss()
                        }
                    }, { runtime.notice("当前无法更改能力配置，请核对连接已完全停止、换钥与更新任务已完成。") })
                }
            }.setNegativeButton("取消", null).show()
    }

    private fun requestStart() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST); return
        }
        val summary = runtime.screen.summary
        if (summary != null && DeviceModelProfile.parse(summary.model).hasAudio) {
            val review = try { runtime.reviewAudioStart() } catch (_: Exception) {
                runtime.notice("本次音量和静音确认已失效，请刷新设备状态后重新核对。"); return
            }
            audioDialog?.dismiss()
            val dialog = AlertDialog.Builder(this).setTitle("允许本次连接调节音量和静音")
                .setMessage("空间：${review.summary.space}\n设备：${review.summary.device}\n\n允许本次连接读取和调节电视的媒体音量、设置静音或取消静音。离开本页面后仍有效；停止、取消授权或应用进程结束后失效，重新连接需要再次允许。音量调节可能影响正在播放的内容。")
                .setNegativeButton("暂不允许", null)
                .setPositiveButton("允许并开始本次连接") { _, _ -> if (runtime.approveAudioStart(review)) startConnection() }
                .create()
            audioDialog = dialog
            dialog.setOnDismissListener { if (audioDialog === dialog) audioDialog = null }
            dialog.show()
            return
        }
        startConnection()
    }

    private fun startConnection() {
        try {
            val intent = Intent(this, AgentService::class.java).setAction(AgentService.ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
        } catch (_: Exception) { runtime.stop(); runtime.notice("无法开始可见连接，请检查通知权限与系统运行限制。") }
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
                .setMessage("空间：${s.space}\n设备：${s.device}\n连接：${s.broker}\n逻辑模型：${s.model}\n模型摘要：${s.revision}\n\nCA指纹：${s.ca}\n设备证书：${s.certificate}\n有效至：${s.expires}\n\n请逐项核对。增加能力的模型切换会保留原日志与未知记录，且不支持退回旧模型。应用启动仍须单独允许；音量和静音须选择音频配置并另行允许本次连接，遥控按键须由网关另行绑定。保存不会自动连接或合并ADB设备。")
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
        navigation.message(s.notice)
        navigation.status(when (s.status) {
            "ready" -> "●  已连接家庭网关"
            "connection_unavailable" -> "○  连接失败，等待重试"
            "handshaking" -> "○  正在核对网关会话"
            "storage_unavailable" -> "○  记录存储异常"
            else -> if (runtime.running) "○  正在连接家庭网关" else "○  连接已停止"
        })
        heroTitle.text = when {
            s.summary == null -> "设置电视连接"
            s.summary.expired -> "证书需要维护"
            s.status == "ready" -> "电视已连接"
            s.status == "connection_unavailable" -> "暂时无法连接网关"
            s.status == "handshaking" -> "正在核对网关会话"
            s.status == "storage_unavailable" -> "设备记录需要检查"
            runtime.running -> "正在建立安全连接"
            else -> "这台电视"
        }
        heroMessage.text = when {
            s.summary == null -> "连接家庭网关，允许手机和电脑控制这台电视。"
            s.summary.expired -> "证书已过期。请进入设备维护，保留原身份并恢复连接资格。"
            s.status == "ready" -> "远程控制已就绪。只有你允许的应用和能力可以被操作。"
            s.status == "connection_unavailable" -> "连接失败，正在自动重试。请检查网关是否运行、连接地址与网络是否可用。"
            s.status == "handshaking" -> "已建立网络连接，正在等待家庭网关确认设备会话。"
            s.status == "storage_unavailable" -> "记录存储异常，连接已阻断。请保留原数据并进入诊断信息核对。"
            runtime.running -> "请保持网络可用。你可以随时停止本次连接。"
            else -> "家庭网关已配置，连接已停止。"
        }
        homeSetup.visibility = if (s.summary == null) View.VISIBLE else View.GONE
        start.visibility = if (s.summary != null && !runtime.running) View.VISIBLE else View.GONE
        stop.visibility = if (runtime.running) View.VISIBLE else View.GONE
        applicationsSummary.text = "${s.allowed.size} 个已允许"
        homeConnectionSummary.text = if (s.summary != null) "已配置" else "尚未配置"
        val currentModel = s.summary?.let { DeviceModelProfile.parse(it.model) }
        capabilitiesSummary.text = currentModel?.let { if (it.hasAudio) "应用与音频" else "应用启动" } ?: "未配置"
        maintenanceSummary.text = currentModel?.let(::modelLabel) ?: "请先完成连接设置"
        details.text = s.summary?.let { "空间：${it.space}\n设备：${it.device}\n连接：${it.broker}\n逻辑模型：${it.model}\nCA指纹：${it.ca}\n证书有效至：${it.expires}" + if (it.expired) "\n证书已过期，仅可维护" else "" } ?: "尚未导入设备材料"
        start.isEnabled = s.summary != null && !s.summary.expired && !runtime.running
        stop.isEnabled = runtime.running
        val audioModel = s.summary?.let { DeviceModelProfile.parse(it.model).hasAudio } == true
        audioStatus.text = if (s.audioAuthorized) "本次连接已允许音量和静音。离开页面后仍有效；停止或取消授权后失效。"
            else if (audioModel) "尚未允许音量和静音。开始连接时需在本机确认，授权仅限本次连接。"
            else "当前配置没有开放音量和静音控制。"
        revokeAudio.isEnabled = audioModel && runtime.running
        val request = s.identityRequest
        connectionStep.text = when {
            s.summary != null -> "连接身份已保存"
            request?.request != null -> "第二步 · 请管理者签发后导入证书"
            request != null -> "恢复已保存的证书申请"
            else -> "第一步 · 导入连接配置"
        }
        connectionSummary.text = s.summary?.let { "设备：${it.device}\n家庭空间：${it.space}\n证书有效至：${it.expires}" }
            ?: if (request?.request != null) "导出原申请交给管理者签发，再将签发的证书导入这台电视。" else "配置来自你的家庭网关。请在确认页面核对设备和连接来源。"
        identitySetup.visibility = if (s.summary == null && request == null) View.VISIBLE else View.GONE
        resumeRequest.visibility = if (request != null && request.phase != "active") View.VISIBLE else View.GONE
        exportRequest.visibility = if (request?.request != null && request.phase != "active") View.VISIBLE else View.GONE
        importCertificate.visibility = exportRequest.visibility
        import.visibility = if (request == null) View.VISIBLE else View.GONE
        modelAssignment.isEnabled = !runtime.running && request?.phase == "active" && s.summary?.expired == false &&
            s.summary.model != DeviceModelProfile.AUDIO_COMPOSED_REMOTE.id &&
            (s.rotation == null || s.rotation.managementCompleted) && s.retirements.none { it.phase == "deleting" }
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
            val focusedPackage = applications.findFocus()?.tag as? String
            applications.removeAllViews()
            val entries = (s.applications + (s.allowed - s.applications.map { it.packageName }.toSet()).map { AndroidApplications.Entry(it, "当前不可启动，可取消授权") }).sortedBy { it.packageName }
            if (entries.isEmpty()) applications.addView(TvUi.label(this, "尚未发现可启动的电视应用。安装电视应用后，请刷新列表。", 17f, true).apply {
                background = TvUi.shape(this@TelevisionActivity, TvUi.surface)
                setPadding(dp(20), dp(28), dp(20), dp(28))
            })
            var restoreFocus: CheckBox? = null
            entries.chunked(2).forEach { pair ->
                val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; clipChildren = false }
                applications.addView(row, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
                pair.forEachIndexed { index, entry ->
                    row.addView(CheckBox(this).apply {
                    TvUi.styleButton(this)
                    tag = entry.packageName
                    val allowed = entry.packageName in s.allowed
                    text = "${entry.label}\n${if (allowed) "已允许启动" else "未授权"}"; textSize = 16f
                    contentDescription = "${entry.label}，${entry.packageName}，${if (allowed) "已允许启动" else "未授权"}"
                    gravity = Gravity.CENTER_VERTICAL; minHeight = dp(84)
                    setPadding(dp(16), dp(14), dp(12), dp(14))
                    isChecked = allowed; isEnabled = s.summary != null && (!s.summary.expired || isChecked)
                    if (focusedPackage == entry.packageName) restoreFocus = this
                    setOnCheckedChangeListener { _, checked -> runtime.authorize(entry.packageName, checked) }
                    }, LinearLayout.LayoutParams(0, -2, 1f).apply { if (index == 0) rightMargin = dp(12) })
                }
                if (pair.size == 1) row.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
            }
            restoreFocus?.let { target -> applications.post { if (resumed && target.isShown && hasWindowFocus()) target.requestFocus() } }
        }
        TvUi.syncEnabledFocus(navigation.root)
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    companion object {
        private const val HOME = 0; private const val CONNECTION = 1; private const val APPLICATIONS = 2
        private const val MAINTENANCE = 3; private const val DIAGNOSTICS = 4
        private const val IMPORT_REQUEST = 41; private const val NOTIFICATION_REQUEST = 42
        private const val SETUP_REQUEST = 43; private const val EXPORT_REQUEST = 44; private const val CERTIFICATE_REQUEST = 45
        private const val EXPORT_ROTATION = 46; private const val ROTATION_RECEIPT = 47; private const val ROTATION_CERTIFICATE = 48
        private const val EXPORT_PROOF = 49; private const val ROTATION_COMPLETION = 50
        private const val RETIREMENT_CRL = 51
    }
}
