package run.limeai.iot.device

import okhttp3.OkHttpClient
import org.eclipse.paho.mqttv5.client.MqttConnectionOptions
import org.eclipse.paho.mqttv5.client.internal.NetworkModule
import org.eclipse.paho.mqttv5.client.spi.NetworkModuleFactory
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** Paho的公开传输SPI；API23与JVM使用相同的独立CA、mTLS及主机名验证。 */
class VerifiedMqttTls : NetworkModuleFactory {
    override fun getSupportedUriSchemes(): Set<String> = setOf("limeiot-ssl")

    override fun validateURI(uri: URI) {
        require(uri.scheme == "limeiot-ssl" && !uri.host.isNullOrEmpty() && uri.port in 1..65535 &&
            uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.rawPath.isNullOrEmpty())
    }

    override fun createNetworkModule(uri: URI, options: MqttConnectionOptions, clientId: String): NetworkModule {
        validateURI(uri)
        val factory = options.socketFactory as? SSLSocketFactory ?: throw IllegalArgumentException("device TLS required")
        require(options.connectionTimeout in 1..5)
        return VerifiedConnection(uri, factory, options.connectionTimeout * 1000)
    }
}

private class VerifiedConnection(
    private val uri: URI,
    private val factory: SSLSocketFactory,
    private val timeoutMillis: Int,
) : NetworkModule {
    private var transport: SSLSocket? = null

    override fun start() {
        check(transport == null)
        val tcp = Socket()
        var tls: SSLSocket? = null
        try {
            tcp.connect(InetSocketAddress(uri.host, uri.port), timeoutMillis)
            // 带原始host的分层工厂由系统设置SNI，不直接引用API24的SNIHostName。
            tls = factory.createSocket(tcp, uri.host, uri.port, true) as SSLSocket
            tls.soTimeout = timeoutMillis
            tls.startHandshake()
            if (!hostnameVerifier.verify(uri.host, tls.session)) {
                tls.session.invalidate()
                throw SSLPeerUnverifiedException("device broker hostname mismatch")
            }
            tls.soTimeout = 1000
            transport = tls
        } catch (failure: Exception) {
            try { tls?.close() } catch (_: Exception) {}
            try { tcp.close() } catch (_: Exception) {}
            throw failure
        }
    }

    override fun getInputStream(): InputStream = checkNotNull(transport).inputStream
    override fun getOutputStream(): OutputStream = checkNotNull(transport).outputStream
    override fun getServerURI(): String = URI("ssl", null, uri.host, uri.port, null, null, null).toASCIIString()
    override fun stop() {
        val current = transport
        transport = null
        current?.close()
    }

    companion object {
        private val hostnameVerifier = OkHttpClient().hostnameVerifier
    }
}
