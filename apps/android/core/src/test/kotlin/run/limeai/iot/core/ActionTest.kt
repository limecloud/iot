package run.limeai.iot.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import java.io.IOException
import kotlin.test.*

class ActionTest {
    @Test fun actualHTTPMQTTActionModelScopeAndOriginalRecovery() = runBlocking {
        if (System.getenv("LIMEIOT_ACTION_CHECK") != "1") return@runBlocking
        var dropped = false
        val base = OkHttpTransport()
        val transport = GatewayTransport { request ->
            val response = base.send(request)
            if (request.method == "POST" && request.url.endsWith("/commands") && !dropped) { dropped = true; throw IOException("response_lost") }
            response
        }
        val client = GatewayClient(requireNotNull(System.getenv("LIMEIOT_ENDPOINT")), transport, allowLoopbackHTTP = true)
        client.login(System.getenv("LIMEIOT_TOKEN"))
        val snapshot = client.snapshot(); val device = snapshot.devices.first { it.deviceId == "device-lamp" }
        val model = snapshot.models.getValue(device.modelRevision)
        assertEquals(2, model.services.sumOf { it.actions.size })
        assertTrue(JsonPrimitive("home") in model.services.first { it.id == "remote" }.actions.single().input.properties.getValue("key").enumValues)
        val intent = CommandIntent.create(device, "remote.press", buildJsonObject { put("key", "home") }, type = "action.invoke")
        assertFailsWith<IOException> { client.create(snapshot.space, intent) }
        var command = client.resolve(snapshot.space, intent.key)
        repeat(50) { if (command.status != "confirmed") { delay(100); command = client.command(snapshot.space, command.commandId) } }
        assertEquals("输入已提交", command.statusText); assertEquals("遥控：主页", command.request.operation.summary)
        assertEquals(command.commandId, client.resolve(snapshot.space, intent.key).commandId)
        val launch = CommandIntent.create(device, "apps.launch", buildJsonObject { put("application_id", "org.example.player") }, type = "action.invoke")
        var application = client.create(snapshot.space, launch)
        repeat(50) { if (application.status != "confirmed") { delay(100); application = client.command(snapshot.space, application.commandId) } }
        assertEquals("输入已提交", application.statusText); assertEquals("启动应用：org.example.player", application.request.operation.summary)
        client.logout()
    }
}
