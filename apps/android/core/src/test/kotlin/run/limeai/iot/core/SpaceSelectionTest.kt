package run.limeai.iot.core

import kotlinx.coroutines.runBlocking
import kotlin.test.*

class SpaceSelectionTest {
    @Test fun selectedSpaceNeverFallsBackToFirstSpace() = runBlocking {
        val paths = mutableListOf<String>()
        val client = GatewayClient("https://gateway.example", GatewayTransport { request ->
            paths += request.url
            val body = when {
                request.url.endsWith("/auth/session") -> """{"authenticated":true,"csrf_token":"csrf","expires_at":"2030-01-01T00:00:00Z"}"""
                request.url.endsWith("/spaces") -> """{"items":[{"space_id":"first"},{"space_id":"chosen"}],"next_cursor":null}"""
                request.url.endsWith("/capabilities") -> """{"models":{}}"""
                else -> """{"items":[],"next_cursor":null}"""
            }
            GatewayResponse(200, body, "__Host-limeiot_session=${"a".repeat(64)}; Secure; HttpOnly")
        })
        client.login("fixture")
        assertEquals(listOf("first","chosen"),client.spaces().map { it.spaceId })
        assertEquals("chosen",client.snapshot("chosen").space)
        assertTrue(paths.filter { it.contains("/spaces/") }.all { it.contains("/spaces/chosen/") })
        val count = paths.size
        assertFailsWith<GatewayException> { client.snapshot("../other") }
        assertEquals(count,paths.size)
    }
}
