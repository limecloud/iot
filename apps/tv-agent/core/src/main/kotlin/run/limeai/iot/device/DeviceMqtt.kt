package run.limeai.iot.device

import okhttp3.OkHttpClient
import org.eclipse.paho.mqttv5.client.*
import org.eclipse.paho.mqttv5.client.persist.MemoryPersistence
import org.eclipse.paho.mqttv5.common.MqttException
import org.eclipse.paho.mqttv5.common.MqttMessage
import org.eclipse.paho.mqttv5.common.packet.MqttProperties
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** MQTT 5 由 Paho 提供。单个工作线程处理应用协议，网络回调只投递有界消息。 */
class DeviceMqtt(
    private val identity: DeviceIdentity,
    broker: String,
    private val tls: DeviceTls,
    storage: DeviceStorage,
    applications: ApplicationPort,
    private val clock: DeviceClock,
    private val status: (String) -> Unit = {},
) : AutoCloseable {
    private val uri = DeviceBroker.parse(broker)
    private data class Incoming(val topic: String, val bytes: ByteArray, val retained: Boolean)
    private val messages = ArrayBlockingQueue<Incoming>(16)
    private val closed = AtomicBoolean(false)
    private val online = AtomicBoolean(false)
    private val running = AtomicBoolean(false)
    private val overflow = AtomicBoolean(false)
    private val wake = Object()
    private var lastStatus: String? = null
    private val agent = DeviceAgent(identity, storage, applications, clock) { online.get() && !closed.get() && !overflow.get() && tls.current }
    private fun report(value: String) { if (lastStatus != value) { lastStatus = value; status(value) } }

    fun run() {
        checkDevice(running.compareAndSet(false, true), "already_running")
        var retry = 1000L
        try {
            while (!closed.get() && !agent.blocked && tls.current) {
                val connection = MqttClient(uri.toASCIIString(), identity.device, MemoryPersistence())
                connection.setTimeToWait(5000)
                connection.setCallback(object : MqttCallback {
                    override fun disconnected(response: MqttDisconnectResponse) { online.set(false) }
                    override fun mqttErrorOccurred(exception: MqttException) { online.set(false) }
                    override fun messageArrived(topic: String, message: MqttMessage) {
                        if (message.payload.size > 16384 || message.isRetained) return
                        if (!messages.offer(Incoming(topic, message.payload.copyOf(), message.isRetained))) { overflow.set(true); online.set(false) }
                    }
                    override fun deliveryComplete(token: IMqttToken) {}
                    override fun connectComplete(reconnect: Boolean, serverURI: String) {}
                    override fun authPacketArrived(reasonCode: Int, properties: MqttProperties) {}
                })
                try {
                    report("connecting")
                    val options = MqttConnectionOptions().apply {
                        isCleanStart = true; sessionExpiryInterval = 0L; isAutomaticReconnect = false
                        connectionTimeout = 5; keepAliveInterval = 10; receiveMaximum = 16; maximumPacketSize = 16896L
                        socketFactory = tls.socketFactory
                        // Paho默认实现调用API24的SSLParameters；API23使用OkHttp同等的主机/SAN校验。
                        isHttpsHostnameVerificationEnabled = false
                        sslHostnameVerifier = OkHttpClient().hostnameVerifier
                    }
                    connection.connect(options)
                    if (closed.get()) break
                    tls.requireCurrent()
                    messages.clear(); overflow.set(false); online.set(true)
                    connection.subscribe("limeiot/v1/${identity.space}/${identity.device}/down/+", 1)
                    fun publish(message: DevicePublication) {
                        tls.requireCurrent()
                        connection.publish(message.topic, message.payload, 1, false)
                    }
                    publish(agent.connected())
                    var lastHeartbeat = clock.elapsedMillis()
                    val welcomeDeadline = lastHeartbeat + 5000
                    report("handshaking")
                    while (!closed.get() && online.get() && connection.isConnected && tls.current) {
                        val incoming = messages.poll(100, TimeUnit.MILLISECONDS)
                        tls.requireCurrent()
                        if (incoming != null) {
                            try { agent.receive(incoming.topic, incoming.bytes, incoming.retained).forEach(::publish) }
                            catch (failure: DeviceFault) {
                                report(failure.code)
                                if (agent.blocked || failure.code in setOf("invalid_time", "invalid_credentials")) break
                            }
                        }
                        val elapsed = clock.elapsedMillis()
                        if (!agent.ready && elapsed >= welcomeDeadline) break
                        if (agent.ready && elapsed - lastHeartbeat >= 2000) {
                            agent.heartbeat()?.let(::publish); agent.pendingReceipt()?.let(::publish); lastHeartbeat = elapsed
                        }
                        if (agent.ready) { retry = 1000; report("ready") }
                    }
                } catch (_: Exception) { report(if (agent.blocked) "storage_unavailable" else if (!tls.current) "invalid_credentials" else "connection_unavailable") }
                finally {
                    online.set(false); agent.disconnected()
                    try { connection.disconnectForcibly(0, 1000, false) } catch (_: Exception) {}
                    try { connection.close(true) } catch (_: Exception) {}
                    messages.clear()
                }
                if (!closed.get() && !agent.blocked && tls.current) {
                    synchronized(wake) { if (!closed.get()) wake.wait(retry) }
                    retry = (retry * 2).coerceAtMost(30000)
                }
            }
        } finally { online.set(false); running.set(false); report(if (agent.blocked) "storage_unavailable" else if (!tls.current) "invalid_credentials" else "stopped") }
    }

    override fun close() {
        closed.set(true); online.set(false)
        synchronized(wake) { wake.notifyAll() }
        // 网络调用在工作线程最多5秒结束；关闭立即阻止新的业务副作用。
    }
}
