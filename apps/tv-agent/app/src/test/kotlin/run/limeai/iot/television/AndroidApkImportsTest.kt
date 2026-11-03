package run.limeai.iot.television

import android.app.Application
import android.os.Build
import android.system.OsConstants
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.Resetter
import org.robolectric.shadows.ShadowLinux
import run.limeai.iot.device.DeviceFault
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileDescriptor
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import kotlin.test.*

/** Robolectric Linux用RandomAccessFile打开目录会报EIO；明确模拟目录fd/sync，文件流仍真实。 */
@Implements(className = "libcore.io.Linux", isInAndroidSdk = false, minSdk = 26)
class ApkImportLinuxFixture : ShadowLinux() {
    private val directories = mutableMapOf<FileDescriptor, Boolean>()
    @Implementation override fun open(path: String, flags: Int, mode: Int): FileDescriptor {
        if (flags == OsConstants.O_RDONLY && File(path).isDirectory)
            return FileDescriptor().also { directories[it] = false }
        return super.open(path, flags, mode)
    }
    @Implementation fun fsync(descriptor: FileDescriptor) {
        if (directories.containsKey(descriptor)) {
            if (failNext) { failNext = false; throw DeviceFault("apk_import_sync_fixture_failed") }
            directories[descriptor] = true; syncRequests++
        }
    }
    @Implementation fun close(descriptor: FileDescriptor) { directories.remove(descriptor) }
    companion object {
        var syncRequests = 0
        var failNext = false
        @Resetter @JvmStatic fun reset() { syncRequests = 0; failNext = false }
    }
}

/** 实际宿主私有目录/文件与有界流；不执行Android安装或宣称实机断电耐久。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [23, 28], application = Application::class, shadows = [ApkImportLinuxFixture::class])
class AndroidApkImportsTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private fun store() = AndroidApkImports(context)
    private fun fault(code: String, action: () -> Unit) = assertEquals(code, assertFailsWith<DeviceFault>(block = action).code)

    @Test fun private_copies_reopen_with_same_id_and_exact_bytes_without_external_uri() {
        val preflight = byteArrayOf(1, 2, 3); val candidate = byteArrayOf(4, 5, 6, 7)
        var closed = false
        val id = store().begin { object : ByteArrayInputStream(preflight) { override fun close() { closed = true; super.close() } } }
        assertTrue(closed)
        assertEquals(listOf(ApkImportEntry(id, true, false)), store().entries())
        store().candidate(id) { ByteArrayInputStream(candidate) }
        val reopened = store(); val files = reopened.files(id)
        assertTrue(files.bundle.canonicalPath.startsWith(context.noBackupFilesDir.canonicalPath + "/"))
        assertContentEquals(preflight, files.bundle.readBytes()); assertContentEquals(candidate, files.candidate.readBytes())
        assertEquals(listOf(ApkImportEntry(id, true, true)), reopened.entries())
        fault("apk_import_already_written") { reopened.candidate(id) { fail("已有副本不能重新读URI") } }
        assertContentEquals(candidate, files.candidate.readBytes())
        if (Build.VERSION.SDK_INT >= 26) {
            assertTrue(ApkImportLinuxFixture.syncRequests >= 6)
            ApkImportLinuxFixture.failNext = true
            fault("apk_import_sync_fixture_failed") { store().begin { fail("目录同步失败不能继续读取材料") } }
            assertEquals(2, store().entries().size)
            assertEquals(1, store().entries().count { it.hasPreflight })
        }
    }

    @Test fun interrupted_stream_stays_incomplete_and_requires_explicit_discard_without_overwrite() {
        assertFailsWith<IOException> { store().begin { object : InputStream() {
            var sent = false
            override fun read() = throw IOException("fixture interrupted")
            override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                if (sent) throw IOException("fixture interrupted")
                sent = true; bytes[offset] = 42; return 1
            }
        } } }
        val incomplete = store().entries().single()
        assertFalse(incomplete.hasPreflight); assertFalse(incomplete.hasCandidate)
        fault("apk_import_incomplete") { store().files(incomplete.requestId) }
        fault("apk_import_incomplete") { store().candidate(incomplete.requestId) { fail("不完整报告不能接受APK") } }
        val part = File(context.noBackupFilesDir, "apk-imports/${incomplete.requestId}/preflight.jar.part")
        assertContentEquals(byteArrayOf(42), part.readBytes())
        store().discard(incomplete.requestId)
        assertTrue(store().entries().isEmpty()); assertFalse(part.exists())
    }

    @Test fun empty_zero_read_and_oversize_streams_never_become_usable_materials() {
        fault("apk_import_incomplete") { store().begin { ByteArrayInputStream(byteArrayOf()) } }
        fault("apk_import_unavailable") { store().begin { object : InputStream() {
            override fun read() = 0
            override fun read(bytes: ByteArray, offset: Int, length: Int) = 0
        } } }
        fault("apk_import_too_large") { store().begin { ByteArrayInputStream(ByteArray(1048577)) } }
        assertEquals(3, store().entries().size)
        assertTrue(store().entries().none { it.hasPreflight || it.hasCandidate })
    }

    @Test fun total_quota_and_path_validation_refuse_copy_without_touching_other_files() {
        val id = store().begin { ByteArrayInputStream(byteArrayOf(1)) }
        val directory = File(context.noBackupFilesDir, "apk-imports/$id")
        // 稀疏宿主夹具消耗逻辑额度，不分配512MiB数据或放宽生产限额。
        RandomAccessFile(File(directory, "preflight.jar"), "rw").use { it.setLength(536870912L) }
        fault("apk_import_too_large") { store().candidate(id) { ByteArrayInputStream(byteArrayOf(1)) } }
        assertFalse(store().entries().single().hasCandidate)
        for (invalid in listOf("../outside", "/tmp/outside", "apk-invalid")) {
            fault("apk_import_unavailable") { store().discard(invalid) }
        }
        val foreign = File(directory, "unexpected.txt").apply { writeText("retain") }
        fault("apk_import_unavailable") { store().discard(id) }
        assertEquals("retain", foreign.readText())
        assertTrue(File(directory, "preflight.jar").isFile)
    }
}
