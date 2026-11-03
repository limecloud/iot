package run.limeai.iot.television

import android.content.Context
import android.system.Os
import android.system.OsConstants
import run.limeai.iot.device.DeviceFault
import run.limeai.iot.device.ApkInstallRecord
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID

internal data class ApkImportEntry(val requestId: String, val hasPreflight: Boolean, val hasCandidate: Boolean)
internal data class ApkImportFiles(val bundle: File, val candidate: File)
internal data class ApkUpdateOverview(val imports: List<ApkImportEntry>, val records: List<ApkInstallRecord>, val importsAvailable: Boolean)

/** 仅保存本机导入副本；URI、显示名及外部路径不进入原任务。调用方持有APK Owner锁。 */
internal class AndroidApkImports(context: Context) {
    private val base = context.noBackupFilesDir.canonicalFile
    private val root = File(base, "apk-imports")

    fun entries(): List<ApkImportEntry> = directories().map { directory ->
        validateFiles(directory)
        ApkImportEntry(directory.name, File(directory, BUNDLE).isFile, File(directory, CANDIDATE).isFile)
    }.sortedBy { it.requestId }

    fun begin(input: () -> InputStream): String {
        val existing = directories()
        requireImport(existing.size < MAX_ENTRIES, "apk_import_capacity")
        if (!root.exists()) {
            requireImport(root.mkdir(), "apk_import_unavailable")
            sync(base)
        }
        val requestId = "apk-" + UUID.randomUUID().toString()
        val directory = File(root, requestId)
        requireImport(directory.mkdir(), "apk_import_unavailable")
        sync(root)
        // 中断或失败保留原目录/part供明确清理，不换ID、不覆盖或后台补读URI。
        copy(directory, BUNDLE, MAX_BUNDLE, input)
        return requestId
    }

    fun candidate(requestId: String, input: () -> InputStream) {
        val directory = directory(requestId)
        requireImport(File(directory, BUNDLE).isFile, "apk_import_incomplete")
        copy(directory, CANDIDATE, MAX_CANDIDATE, input)
    }

    fun files(requestId: String): ApkImportFiles {
        val directory = directory(requestId)
        requireImport(File(directory, BUNDLE).isFile && File(directory, CANDIDATE).isFile, "apk_import_incomplete")
        return ApkImportFiles(File(directory, BUNDLE), File(directory, CANDIDATE))
    }

    /** 仅供明确丢弃未批准副本；是否已有账本计划必须由同一Owner先行核对。 */
    fun discard(requestId: String) {
        val directory = directory(requestId)
        validateFiles(directory).forEach { requireImport(it.delete(), "apk_import_unavailable") }
        requireImport(directory.delete(), "apk_import_unavailable")
        sync(root)
    }

    private fun copy(directory: File, name: String, maximum: Long, input: () -> InputStream) {
        val remaining = MAX_TOTAL - directories().sumOf { validateFiles(it).sumOf(File::length) }
        val destination = File(directory, name)
        val part = File(directory, "$name.part")
        requireImport(!destination.exists() && part.createNewFile(), "apk_import_already_written")
        sync(directory)
        var size = 0L
        input().use { source -> FileOutputStream(part).use { output ->
            val block = ByteArray(65536)
            while (true) {
                val count = source.read(block)
                if (count < 0) break
                requireImport(count > 0, "apk_import_unavailable")
                size += count
                requireImport(size <= maximum && size <= remaining, "apk_import_too_large")
                output.write(block, 0, count)
            }
            requireImport(size > 0, "apk_import_incomplete")
            output.fd.sync()
        } }
        requireImport(part.renameTo(destination), "apk_import_unavailable")
        sync(directory)
    }

    private fun directories(): List<File> {
        if (!root.exists()) return emptyList()
        requireImport(root.isDirectory && root.canonicalFile == root.absoluteFile, "apk_import_unavailable")
        val result = root.listFiles()?.toList() ?: throw DeviceFault("apk_import_unavailable")
        requireImport(result.size <= MAX_ENTRIES, "apk_import_capacity")
        result.forEach { requireImport(id.matches(it.name) && it.isDirectory && it.canonicalFile == it.absoluteFile, "apk_import_unavailable") }
        return result
    }

    private fun directory(requestId: String): File {
        requireImport(id.matches(requestId), "apk_import_unavailable")
        return (directories().singleOrNull { it.name == requestId } ?: throw DeviceFault("apk_import_not_found"))
            .also { validateFiles(it) }
    }

    private fun validateFiles(directory: File): List<File> {
        val files = directory.listFiles()?.toList() ?: throw DeviceFault("apk_import_unavailable")
        requireImport(files.size <= 4 && files.all { it.name in names && it.isFile && it.canonicalFile == it.absoluteFile }, "apk_import_unavailable")
        return files
    }

    private fun sync(directory: File) {
        val descriptor = Os.open(directory.path, OsConstants.O_RDONLY, 0)
        try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
    }

    companion object {
        private const val BUNDLE = "preflight.jar"
        private const val CANDIDATE = "candidate.apk"
        private const val MAX_BUNDLE = 1048576L
        private const val MAX_CANDIDATE = 268435456L
        private const val MAX_TOTAL = 536870912L
        private const val MAX_ENTRIES = 128
        private val id = Regex("apk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        private val names = setOf(BUNDLE, CANDIDATE, "$BUNDLE.part", "$CANDIDATE.part")
        private fun requireImport(valid: Boolean, code: String) { if (!valid) throw DeviceFault(code) }
    }
}
