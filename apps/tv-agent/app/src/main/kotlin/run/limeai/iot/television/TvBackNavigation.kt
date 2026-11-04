package run.limeai.iot.television

import android.annotation.TargetApi
import android.app.Activity
import android.os.Build

/** 新系统使用系统返回回调；API23不会加载较新的窗口类型。 */
internal class TvBackNavigation(private val activity: Activity, private val returnHome: () -> Unit) {
    private var unregister: (() -> Unit)? = null

    fun update(enabled: Boolean) {
        if (Build.VERSION.SDK_INT < 33) return
        if (enabled && unregister == null) unregister = Api33.register(activity, returnHome)
        if (!enabled) close()
    }

    fun close() { unregister?.invoke(); unregister = null }

    private object Api33 {
        @TargetApi(33)
        fun register(activity: Activity, action: () -> Unit): () -> Unit {
            val dispatcher = activity.onBackInvokedDispatcher
            val callback = android.window.OnBackInvokedCallback { action() }
            dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
            return { dispatcher.unregisterOnBackInvokedCallback(callback) }
        }
    }
}
