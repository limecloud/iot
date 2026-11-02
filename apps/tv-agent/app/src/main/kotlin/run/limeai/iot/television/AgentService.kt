package run.limeai.iot.television

import android.app.*
import android.content.Intent
import android.os.Build
import android.os.IBinder

class AgentService : Service() {
    private val runtime get() = (application as TelevisionApplication).runtime
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != ACTION_START) { runtime.stop(); stopSelf(); return START_NOT_STICKY }
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, TelevisionActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, AgentService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this))
            .setSmallIcon(R.drawable.ic_television).setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text)).setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, getString(R.string.stop), stop).build()).build()
        startForeground(1, notification)
        runtime.start { stopSelf() }
        return START_NOT_STICKY // 回收或重启不自行恢复控制，用户重新开始后建立新设备会话。
    }
    override fun onDestroy() { runtime.stop(); super.onDestroy() }
    companion object {
        const val ACTION_START = "run.limeai.iot.television.START"
        const val ACTION_STOP = "run.limeai.iot.television.STOP"
        private const val CHANNEL = "tv-agent-connection"
    }
}
