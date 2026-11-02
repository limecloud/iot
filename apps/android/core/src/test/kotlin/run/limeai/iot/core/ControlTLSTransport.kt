package run.limeai.iot.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.nio.file.Files
import java.nio.file.Path
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

// 仅测试使用独立CA；OkHttp默认主机名验证保持启用，不修改系统信任。
fun controlTLSTransport(caFile: String): GatewayTransport {
    val certificate = Files.newInputStream(Path.of(caFile)).use { CertificateFactory.getInstance("X.509").generateCertificate(it) }
    val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("fixture-ca", certificate) }
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
    val trust = factory.trustManagers.filterIsInstance<X509TrustManager>().single()
    val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
    val client = OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, trust).followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).callTimeout(12, TimeUnit.SECONDS).cache(null).build()
    return GatewayTransport { request -> withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(request.url)
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        builder.method(request.method, request.body?.toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { GatewayResponse(it.code, it.body?.string().orEmpty(), it.header("Set-Cookie")) }
    } }
}
