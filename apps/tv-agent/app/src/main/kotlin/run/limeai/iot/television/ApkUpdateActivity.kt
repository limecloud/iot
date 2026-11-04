package run.limeai.iot.television

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.FrameLayout
import run.limeai.iot.device.*

/** 本地文件导入及可见批准；不在生命周期回调创建/提交系统安装会话。 */
class ApkUpdateActivity : Activity() {
    private val runtime get() = (application as TelevisionApplication).runtime
    private lateinit var content: LinearLayout
    private lateinit var notice: TextView
    private lateinit var entries: LinearLayout
    private lateinit var import: Button
    private var pendingCandidate: String? = null
    private var busy = false
    private var resumed = false
    private var foreground: RunPermit? = null
    private val resultObserver: () -> Unit = { if (resumed) refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        pendingCandidate = savedInstanceState?.getString("candidate_request")
        content = TvUi.column(this, 24)
        label("设备维护 / 应用更新", 14f)
        label("应用更新", 30f)
        label("先停止设备连接，再选择签名预检文件与同次发布的 APK。核对版本、签名与权限变化后保存计划；安装后还须核对原身份、记录与健康。")
        notice = label("")
        import = button("导入签名预检文件") { choose(PREFLIGHT) }
        button("刷新原更新记录") { refresh() }
        entries = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also(content::addView)
        button("返回设备页面") { finish() }
        val frame = FrameLayout(this).apply {
            setBackgroundColor(TvUi.background)
            addView(ScrollView(this@ApkUpdateActivity).apply {
                isFillViewport = true
                setPadding(TvUi.dp(context, 72), TvUi.dp(context, 24), TvUi.dp(context, 72), TvUi.dp(context, 24))
                clipToPadding = false; addView(content)
            }, FrameLayout.LayoutParams(-1, -1))
        }
        setContentView(frame)
        import.requestFocus()
    }

    override fun onStart() { super.onStart(); ApkInstallConfirmations.observe(resultObserver) }
    override fun onStop() { ApkInstallConfirmations.remove(resultObserver); super.onStop() }
    override fun onResume() { super.onResume(); resumed = true; foreground = RunPermit(); runtime.setVisible(true); refresh() }
    override fun onPause() { foreground?.stop(); foreground = null; resumed = false; runtime.setVisible(false); super.onPause() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("candidate_request", pendingCandidate)
        super.onSaveInstanceState(outState)
    }

    private fun choose(code: Int) {
        try { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), code) }
        catch (_: ActivityNotFoundException) { notice.text = "需要可用的系统文件选择器。" }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == SOURCE_SETTINGS || requestCode == SYSTEM_CONFIRMATION) {
            notice.setText(R.string.apk_system_returned)
            refresh() // Activity结果不能当作系统安装结果，也不能自动继续或重提交。
            return
        }
        val requestId = pendingCandidate
        if (requestCode == CANDIDATE) pendingCandidate = null
        if (resultCode != RESULT_OK) { notice.text = "已取消选择；导入副本与原更新记录保留。"; refresh(); return }
        val uri = data?.data ?: return
        if (requestCode == PREFLIGHT) {
            busy = true
            runtime.importApkPreflight(uri) { result -> complete(result) { id ->
                pendingCandidate = id
                notice.setText(R.string.apk_preflight_imported)
                choose(CANDIDATE)
            } }
        } else if (requestCode == CANDIDATE) {
            if (requestId == null) { notice.setText(R.string.apk_candidate_resume); refresh(); return }
            busy = true
            runtime.importApkCandidate(requestId, uri) { result -> complete(result) { preview(requestId) } }
        }
    }

    private fun refresh() {
        runtime.apkUpdates { result ->
            if (isFinishing || isDestroyed) return@apkUpdates
            result.fold({ (imports, records, available) ->
                import.isEnabled = available && !busy && !runtime.running && records.none { it.blocksAnotherInstall }
                entries.removeAllViews()
                if (!available) row("导入副本不可用，已停止新增导入；原更新账本继续保留。")
                if (imports.isEmpty() && records.isEmpty()) row("尚无更新材料或计划。")
                val ids = (imports.map { it.requestId } + records.map { it.plan.requestId }).distinct()
                ids.forEach { id ->
                    val record = records.find { it.plan.requestId == id }
                    val draft = imports.find { it.requestId == id }
                    row("申请：$id\n" + if (record == null) {
                        if (draft?.hasPreflight == true && draft.hasCandidate) "材料已导入，等待核对与批准" else "导入尚未完成；中断副本保留"
                    } else "版本：${record.plan.baselineVersion} → ${record.plan.candidateVersion}\n${phase(record.phase)}")
                    if (record == null) {
                        if (draft?.hasPreflight == true && !draft.hasCandidate) action("继续选择原 APK") { pendingCandidate = id; choose(CANDIDATE) }
                        if (draft?.hasPreflight == true && draft.hasCandidate) action("核对版本与权限") { preview(id) }
                        action("丢弃未批准导入副本") {
                            AlertDialog.Builder(this).setTitle("丢弃导入副本")
                                .setMessage("仅删除本机此申请的未批准副本。原文件保持在文件提供方，尚未开始系统安装。")
                                .setNegativeButton("保留", null).setPositiveButton("确认丢弃") { _, _ ->
                                    busy = true; runtime.discardApkImport(id) { complete(it) { notice.text = "未批准副本已丢弃。" } }
                                }.show()
                        }
                    } else {
                        if (record.phase in setOf(ApkInstallPhase.PREPARED, ApkInstallPhase.CREATED, ApkInstallPhase.STAGED)) {
                            action("核对安装来源设置") { sourceSettings(id) }
                            action("核对并继续原安装") { preview(id, record) }
                        }
                        if (record.phase == ApkInstallPhase.PENDING_USER) {
                            if (ApkInstallConfirmations.available(record)) action("核对并打开原系统确认") { preview(id, record) }
                            else row("原系统确认入口当前不可用。请保留原任务并核对系统状态，不会再次提交以获取确认。")
                        }
                        if (record.phase == ApkInstallPhase.INSTALLED_UNVERIFIED) action("核对更新后状态") { previewHealth(id) }
                        if (record.phase in setOf(ApkInstallPhase.COMMITTING, ApkInstallPhase.PENDING_USER))
                            action("核对已运行候选包") { previewPackageRecovery(id) }
                        if (record.phase == ApkInstallPhase.LOCAL_PACKAGE_RECOVERED) {
                            val outcome = when (record.recoveryResult) {
                                ApkSystemResult.INSTALLED -> "后来报告安装成功"
                                ApkSystemResult.FAILED -> "后来报告安装失败"
                                ApkSystemResult.CANCELLED -> "后来报告安装取消"
                                else -> "尚未收到最终结果"
                            }
                            row("本机独立恢复前：${phase(record.recoveredFrom!!)}\n原系统安装：$outcome")
                        }
                        if (!record.phase.terminal) action("查询原安装记录") {
                            busy = true; runtime.recoverApkUpdate(id) { complete(it) { notice.text = phase(it.phase) } }
                        }
                        if (record.phase == ApkInstallPhase.PREPARED) action("取消尚未开始的计划") {
                        AlertDialog.Builder(this).setTitle("取消原更新计划")
                            .setMessage("此计划尚未创建系统安装会话。取消后保留材料与原记录，可手动恢复设备连接。")
                            .setNegativeButton("保留", null).setPositiveButton("确认取消原计划") { _, _ ->
                                busy = true; runtime.cancelPreparedApkUpdate(id) { complete(it) { notice.text = "原计划已取消；没有自动连接。" } }
                            }.show()
                        }
                    }
                }
            }, { notice.text = failure(it); import.isEnabled = false })
        }
    }

    private fun sourceSettings(requestId: String) {
        val interaction = foreground ?: return
        busy = true
        runtime.apkSourceSettings(requestId, interaction) { result -> complete(result) { intent ->
            if (!interaction.active) return@complete
            if (intent == null) { notice.setText(R.string.apk_source_already_allowed); return@complete }
            try { startActivityForResult(intent, SOURCE_SETTINGS) }
            catch (_: Exception) { notice.setText(R.string.apk_source_settings_unavailable) }
        } }
    }

    private fun previewHealth(requestId: String) {
        val interaction = foreground ?: return
        busy = true
        runtime.previewApkHealth(requestId, interaction) { result -> complete(result) { review ->
            if (!interaction.active) return@complete
            showHealthReview(requestId, review.health, interaction)
        } }
    }

    private fun previewPackageRecovery(requestId: String) {
        val interaction = foreground ?: return
        busy = true
        runtime.previewApkPackageRecovery(requestId, interaction) { result -> complete(result) { review ->
            if (!interaction.active) return@complete
            showHealthReview(requestId, review.health, interaction, review)
        } }
    }

    private fun showHealthReview(requestId: String, health: ApkLocalHealth, interaction: RunPermit, recovery: ApkPackageRecoveryReview? = null) {
        val recovering = recovery != null
        val explanation = if (recovering) "原系统安装的最终结果尚未收到。本次按已运行的原候选包独立核对本机状态，原阶段与迟到的系统结果继续保留。\n\n" else ""
        val dialog = AlertDialog.Builder(this).setTitle(if (recovering) "核对已运行候选包" else "核对更新后状态")
            .setMessage("申请：$requestId\n当前运行版本：${health.runningVersion}\nAPK摘要：${health.installedSha256}\n签名：${health.signerSha256}\n设备证书：${health.certificateSha256}\n\n${explanation}原身份、密钥、应用授权和完整命令记录核对一致；本机凭据有效，应用发现可用。\n\n接受后可手动恢复连接。本次核对未测试联网或远程操控；不会自动连接或重放命令。")
            .setNegativeButton("暂不接受", null).setPositiveButton(if (recovering) "接受本机恢复" else "接受本机健康", null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (busy) return@setOnClickListener
                if (!interaction.active) { dialog.dismiss(); return@setOnClickListener }
                busy = true
                val completed: (Result<ApkInstallRecord>) -> Unit = { accepted -> complete(accepted) {
                    notice.text = if (recovering) "已按候选包恢复本机状态；原系统结果单独保留，可手动连接。" else "已接受本机健康；可返回设备页面手动连接。"
                    dialog.dismiss()
                } }
                if (recovery != null) runtime.acceptApkPackageRecovery(recovery, interaction, completed)
                else runtime.acceptApkHealth(ApkLocalHealthReview(requestId, health), interaction, completed)
            }
        }
        dialog.show()
    }

    private fun preview(requestId: String, record: ApkInstallRecord? = null) {
        val interaction = foreground ?: return
        busy = true
        runtime.previewApkUpdate(requestId) { result -> complete(result) { review ->
            if (!interaction.active) return@complete
            val installing = record != null
            val confirming = record?.phase == ApkInstallPhase.PENDING_USER
            val debug = CheckBox(this).apply { text = "明确允许此开发包"; isFocusable = true }
            val action = if (confirming) "打开原系统确认" else if (installing) "核对一致并继续原安装" else "核对一致并保存计划"
            val explanation = if (confirming) "即将打开原系统会话的确认页面，由系统再次征求同意。返回不代表安装成功，原任务继续等待系统回执。" else if (installing)
                "即将沿此原计划创建或继续原系统安装会话并提交一次。提交后不能取消本机计划或重新发送；请在系统页面确认或取消。" else
                "保存后连接暂停，尚未开始系统安装。可取消尚未开始的计划。"
            val dialog = AlertDialog.Builder(this).setTitle(if (installing) "核对原安装任务" else "核对并保存更新计划")
                .setMessage("申请：${review.requestId}\n版本：${review.baselineVersion} → ${review.candidateVersion}\n大小：${review.candidateBytes} 字节\n开发包：${if (review.debug) "是" else "否"}\n签名：${review.signerSha256}\nAPK摘要：${review.candidateSha256}\n\n新增权限：\n${review.addedPermissions.joinToString("\n").ifEmpty { "无" }}\n\n移除权限：\n${review.removedPermissions.joinToString("\n").ifEmpty { "无" }}\n\n$explanation\n系统安装成功后仍需核对原身份、授权、命令记录和健康。")
                .setNegativeButton("暂不批准", null).setPositiveButton(action, null)
                .apply { if (review.debug) setView(debug) }.create()
            dialog.setOnShowListener {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    if (busy) return@setOnClickListener
                    if (!interaction.active) { dialog.dismiss(); return@setOnClickListener }
                    if (review.debug && !debug.isChecked) { notice.text = "开发包需要单独明确允许。"; return@setOnClickListener }
                    busy = true
                    val allowDebug = review.debug && debug.isChecked
                    if (confirming) runtime.openApkConfirmation(review, allowDebug, interaction,
                        { intent -> startActivityForResult(intent, SYSTEM_CONFIRMATION) }) { opened -> complete(opened) {
                            notice.setText(R.string.apk_system_confirmation_opened); dialog.dismiss()
                        } }
                    else if (installing) runtime.continueApkUpdate(review, allowDebug, interaction) { advanced -> complete(advanced) {
                        notice.text = phase(it.phase); dialog.dismiss()
                    } }
                    else runtime.approveApkUpdate(review, allowDebug) { approved -> complete(approved) {
                        notice.text = "原计划已保存，尚未开始安装。可取消此计划恢复连接。"; dialog.dismiss()
                    } }
                }
            }
            dialog.show()
        } }
    }

    private fun <T> complete(result: Result<T>, accepted: (T) -> Unit) {
        busy = false
        if (isFinishing || isDestroyed || !resumed) return
        result.fold(accepted) { notice.text = failure(it) }
        refresh()
    }

    private fun failure(error: Throwable): String = when (val code = (error as? DeviceFault)?.code ?: (error as? AgentStoreFault)?.code) {
        "apk_install_stop_required" -> "请先停止连接并等待在途工作完全结束。"
        "apk_install_in_progress" -> "原更新尚未完成，请继续核对原任务。"
        "apk_import_incomplete", "apk_import_already_written" -> "导入副本不完整或已有写入，已保留；请明确丢弃未批准副本后重新选择。"
        "apk_import_capacity", "apk_import_too_large" -> "材料超出大小或保留容量限制；可丢弃未批准副本释放空间。"
        "apk_install_visible_approval_required" -> "请返回此页面，重新核对并明确批准。"
        "apk_preflight_debug_requires_approval" -> "开发包需要单独明确允许。"
        "apk_install_source_authorization_required" -> "系统尚未允许此安装来源。请核对安装来源设置，返回后再次明确继续原安装。"
        "apk_install_policy_restricted" -> "系统管理策略禁止安装，请保留原任务并由设备所有者核对。"
        "apk_install_confirmation_unavailable" -> "原系统确认入口不可用，保留原待确认任务，不会重新提交。"
        "apk_install_confirmation_expired", "apk_install_interaction_busy" -> "本次核对已失效或原任务正忙，请返回原记录重新核对。"
        "apk_install_health_process_mismatch" -> "请保留应用数据并从系统重新打开更新后的 Agent，再核对本机健康。"
        "apk_install_health_not_ready" -> "原任务尚无系统安装成功回执，保持原任务并继续核对。"
        "apk_install_package_recovery_not_ready" -> "原任务状态已变化，请刷新后重新核对；本次没有接受恢复。"
        "apk_install_recovery_sessions_present" -> "系统仍保留安装会话，请先核对原系统安装；本次没有接受恢复。"
        "apk_install_recovery_sessions_unavailable" -> "无法核对系统安装会话，原任务继续保留。"
        "apk_install_health_mismatch", "apk_install_continuity_changed" -> "本机状态与原计划或本次审阅不一致，继续保留更新阻断。"
        else -> "无法继续，请保留原记录并核对材料。" + (code?.let { "（$it）" } ?: "")
    }

    private fun phase(value: ApkInstallPhase) = when (value) {
        ApkInstallPhase.PREPARED -> "已保存计划，尚未开始安装；可取消"
        ApkInstallPhase.CREATING -> "系统会话创建结果待核对，保持原任务"
        ApkInstallPhase.CREATED -> "原系统会话已创建"
        ApkInstallPhase.STAGED -> "原系统会话材料已核对"
        ApkInstallPhase.COMMITTING -> "已记录原提交意图，结果待核对；不会再次提交"
        ApkInstallPhase.PENDING_USER -> "等待原系统确认；保持原任务"
        ApkInstallPhase.INSTALLED_UNVERIFIED -> "系统报告安装成功，原身份、记录与健康尚未验收"
        ApkInstallPhase.LOCAL_HEALTH_ACCEPTED -> "本机健康已接受；可手动连接，联网和远程控制待单独验收"
        ApkInstallPhase.LOCAL_PACKAGE_RECOVERED -> "已按已运行候选包接受本机恢复；原系统结果单独保留，可手动连接"
        ApkInstallPhase.FAILED -> "系统报告原安装失败，原记录保留"
        ApkInstallPhase.CANCELLED -> "原计划或系统安装已取消，原记录保留"
    }
    private fun label(value: String, size: Float = 16f) = TvUi.label(this, value, size, size < 20f).also {
        content.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = TvUi.dp(this@ApkUpdateActivity, 12) })
    }
    private fun button(value: String, click: () -> Unit) = TvUi.button(this, value) { if (!busy) click() }.also(content::addView)
    private fun row(value: String) {
        entries.addView(TvUi.card(this).apply { addView(TvUi.label(this@ApkUpdateActivity, value, 16f)) },
            LinearLayout.LayoutParams(-1, -2).apply { topMargin = TvUi.dp(this@ApkUpdateActivity, 20) })
    }
    private fun action(value: String, click: () -> Unit) {
        entries.addView(TvUi.button(this, value) { if (!busy) click() }.apply { isEnabled = !busy && !runtime.running })
    }
    companion object {
        private const val PREFLIGHT = 61; private const val CANDIDATE = 62
        private const val SOURCE_SETTINGS = 63; private const val SYSTEM_CONFIRMATION = 64
    }
}
