package run.limeai.iot

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable internal fun RecordingButtons(recorder: RecordingController, state: RecordingState, enabled: Boolean, beforeStart: () -> Unit) {
    val context = LocalContext.current
    var permissionEpoch by remember { mutableStateOf<Long?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val epoch = permissionEpoch; permissionEpoch = null
        if (epoch != null) recorder.authorize(epoch, granted)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (state.phase == RecordingPhase.IDLE) {
            OutlinedButton(onClick = {
                beforeStart()
                val epoch = recorder.request()
                if (epoch != null) {
                    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) recorder.authorize(epoch, true)
                    else { permissionEpoch = epoch; permission.launch(Manifest.permission.RECORD_AUDIO) }
                }
            }, enabled = enabled, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline), modifier = Modifier.testTag("recording-start")) { Text("开始录音") }
        } else {
            if (state.phase == RecordingPhase.RECORDING) OutlinedButton(onClick = recorder::finish, border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outline), modifier = Modifier.testTag("recording-finish")) { Text("完成录音") }
            TextButton(onClick = { permissionEpoch = null; recorder.cancel() }, modifier = Modifier.testTag("recording-cancel")) { Text("取消录音") }
        }
    }
    val status = when (state.phase) {
        RecordingPhase.REQUESTING -> "等待麦克风授权"
        RecordingPhase.STARTING -> "正在准备录音"
        RecordingPhase.RECORDING -> "正在录音 ${state.seconds} / 60 秒"
        RecordingPhase.FINISHING -> "正在保存录音"
        RecordingPhase.IDLE -> state.message
    }
    if (status.isNotEmpty()) Text(status, fontSize = 14.sp, modifier = Modifier.testTag("recording-status"))
}
