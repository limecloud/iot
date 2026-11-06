package run.limeai.iot.core

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.BufferedInputStream
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.Collections
import java.util.concurrent.CompletableFuture
import kotlin.concurrent.thread
import kotlin.test.*

class TransportRecoveryTest {
    // 服务端已读取完整请求但丢失响应。只有GET允许传输层重新读取，POST必须回到原操作恢复。
    private class DroppedResponseServer(private val replyToRetry:Boolean=true,private val truncatedSecond:Boolean=false) : AutoCloseable {
        private val server=ServerSocket(0).apply{soTimeout=2500}
        val url="http://127.0.0.1:${server.localPort}/resource"
        val methods=Collections.synchronizedList(mutableListOf<String>())
        val done=CompletableFuture<Unit>()
        private val worker=thread(isDaemon=true){
            try {
                server.accept().use { first ->
                    first.soTimeout=2500
                    val input=BufferedInputStream(first.getInputStream())
                    read(input);reply(first)
                    read(input) // 故意在读取第二个请求后断开，或返回不完整响应。
                    if(truncatedSecond)first.getOutputStream().apply{write("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n{}".toByteArray());flush()}
                }
                if(!truncatedSecond)try {server.accept().use { retry ->retry.soTimeout=2500;read(BufferedInputStream(retry.getInputStream()));if(replyToRetry)reply(retry)}}catch(_:SocketTimeoutException){}
                done.complete(Unit)
            }catch(error:Throwable){done.completeExceptionally(error)}
        }
        private fun read(input:BufferedInputStream){
            fun line():String {val bytes=ArrayList<Byte>();while(true){val b=input.read();check(b>=0){"request_missing"};if(b==10)break;bytes.add(b.toByte());check(bytes.size<8192)};return bytes.toByteArray().toString(Charsets.US_ASCII).trimEnd('\r')}
            methods.add(line().substringBefore(' '))
            var length=0
            while(true){val header=line();if(header.isEmpty())break;if(header.startsWith("Content-Length:",ignoreCase=true))length=header.substringAfter(':').trim().toInt()}
            repeat(length){check(input.read()>=0)}
        }
        private fun reply(socket:Socket){socket.getOutputStream().apply{write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}".toByteArray());flush()}}
        override fun close(){server.close();worker.join(3000)}
    }
    @Test fun readRecoversWhenResponseIsLost()=runBlocking {
        DroppedResponseServer().use { server ->
            val transport=OkHttpTransport()
            assertEquals(200,transport.send(GatewayRequest(server.url,"GET",emptyMap(),null)).status)
            assertEquals(200,transport.send(GatewayRequest(server.url,"GET",emptyMap(),null)).status)
            server.done.get()
            assertEquals(listOf("GET","GET","GET"),server.methods)
        }
    }
    @Test fun submittedPostIsNeverReplayed()=runBlocking {
        DroppedResponseServer().use { server ->
            val transport=OkHttpTransport()
            transport.send(GatewayRequest(server.url,"GET",emptyMap(),null))
            assertFailsWith<IOException>{transport.send(GatewayRequest(server.url,"POST",mapOf("Idempotency-Key" to "original-test-operation"),"{}"))}
            server.done.get()
            assertEquals(listOf("GET","POST"),server.methods)
        }
    }
    @Test fun readFailureIsBounded()=runBlocking {
        DroppedResponseServer(replyToRetry=false).use { server ->
            val transport=OkHttpTransport()
            transport.send(GatewayRequest(server.url,"GET",emptyMap(),null))
            withTimeout(5000){assertFailsWith<IOException>{transport.send(GatewayRequest(server.url,"GET",emptyMap(),null))}}
            server.done.get()
            assertEquals(listOf("GET","GET","GET"),server.methods)
        }
    }
    @Test fun truncatedResponseResumesWithFailure()=runBlocking {
        DroppedResponseServer(truncatedSecond=true).use { server ->
            val transport=OkHttpTransport()
            transport.send(GatewayRequest(server.url,"GET",emptyMap(),null))
            withTimeout(5000){assertFailsWith<IOException>{transport.send(GatewayRequest(server.url,"POST",emptyMap(),"{}"))}}
            server.done.get()
            assertEquals(listOf("GET","POST"),server.methods)
        }
    }
}
