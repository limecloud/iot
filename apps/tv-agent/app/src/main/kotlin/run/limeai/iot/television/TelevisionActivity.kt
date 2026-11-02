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
    private var lastApplications: Pair<List<AndroidApplications.Entry>, Set<String>>? = null
    private val observer: () -> Unit = { render() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(40), dp(24), dp(40), dp(32)) }
        fun label(value: String, size: Float = 18f) = TextView(this).apply { text = value; textSize = size; setPadding(0, dp(8), 0, dp(8)) }.also(content::addView)
        label(getString(R.string.app_name), 28f)
        label("使用手机或电脑控制这台电视。请先核对设备材料，再明确允许可启动的应用。")
        status = label("未连接", 22f); notice = label(""); details = label("尚未导入设备材料")
        fun button(value: String, action: () -> Unit) = Button(this).apply { text = value; isFocusable = true; setOnClickListener { action() } }.also(content::addView)
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
        import.requestFocus()
    }
    override fun onStart() { super.onStart(); runtime.observe(observer); runtime.refresh() }
    override fun onResume() { super.onResume(); runtime.setVisible(true) }
    override fun onPause() { runtime.setVisible(false); super.onPause() }
    override fun onStop() { runtime.remove(observer); super.onStop() }

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
        if (requestCode != IMPORT_REQUEST || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        runtime.readEnrollment(uri) { enrollment ->
            if (isFinishing || isDestroyed) return@readEnrollment
            val s = runtime.summary(enrollment)
            AlertDialog.Builder(this).setTitle("核对设备身份")
                .setMessage("空间：${s.space}\n设备：${s.device}\n连接：${s.broker}\n逻辑模型：${s.model}\n模型摘要：${s.revision}\n\nCA指纹：${s.ca}\n设备证书：${s.certificate}\n有效至：${s.expires}\n\n请逐项核对。切换遥控组合模型会保留原日志与未知记录，且不支持退回旧模型。本应用仍只执行获准的应用启动，遥控按键须由网关另行绑定。保存不会自动连接或合并ADB设备。")
                .setNegativeButton("取消", null)
                .setPositiveButton("核对一致并保存") { _, _ -> runtime.install(enrollment) }.show()
        }
    }
    private fun render() {
        val s = runtime.screen
        val statuses = mapOf("stopped" to "已停止", "stopping" to "正在停止", "connecting" to "正在连接", "handshaking" to "正在核对设备会话", "ready" to "设备连接就绪", "connection_unavailable" to "连接失败，正在等待重连", "storage_unavailable" to "记录存储不可用，连接已阻断")
        status.text = statuses[s.status] ?: "设备未就绪（${s.status}）"
        notice.text = s.notice
        details.text = s.summary?.let { "空间：${it.space}\n设备：${it.device}\n连接：${it.broker}\n逻辑模型：${it.model}\nCA指纹：${it.ca}\n证书有效至：${it.expires}" } ?: "尚未导入设备材料"
        start.isEnabled = s.summary != null && !runtime.running
        stop.isEnabled = runtime.running
        import.isEnabled = !runtime.running
        val listState = s.applications to s.allowed
        if (lastApplications != listState) {
            lastApplications = listState
            applications.removeAllViews()
            val entries = (s.applications + (s.allowed - s.applications.map { it.packageName }.toSet()).map { AndroidApplications.Entry(it, "当前不可启动，可取消授权") }).sortedBy { it.packageName }
            if (entries.isEmpty()) applications.addView(TextView(this).apply { text = "尚未发现可启动的电视应用。" })
            entries.forEach { entry ->
                applications.addView(CheckBox(this).apply {
                    text = "${entry.label}\n${entry.packageName}"; textSize = 18f
                    isChecked = entry.packageName in s.allowed; isEnabled = s.summary != null
                    isFocusable = true
                    setOnCheckedChangeListener { _, checked -> runtime.authorize(entry.packageName, checked) }
                })
            }
        }
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    companion object { private const val IMPORT_REQUEST = 41; private const val NOTIFICATION_REQUEST = 42 }
}
