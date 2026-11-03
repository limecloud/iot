package run.limeai.iot

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import run.limeai.iot.core.MediaChanges
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.IOException

// 调用方在IO调度器中打开文件并负责关闭；不读取声明大小，不保留URI权限。
object MediaFile {
    suspend fun read(input: InputStream, maxBytes: Int = MediaChanges.MAX_AUDIO_BYTES): ByteArray {
        if (maxBytes !in 1..MediaChanges.MAX_AUDIO_BYTES) throw IOException("invalid_file_limit")
        val output = ByteArrayOutputStream(); val buffer = ByteArray(65536)
        while (output.size() <= maxBytes) {
            currentCoroutineContext().ensureActive()
            val count = input.read(buffer, 0, minOf(buffer.size, maxBytes + 1 - output.size()))
            if (count < 0) break
            if (count == 0) throw IOException("unreadable_audio")
            output.write(buffer, 0, count)
        }
        currentCoroutineContext().ensureActive()
        if (output.size() > maxBytes) throw IOException("file_too_large")
        return output.toByteArray()
    }
}
