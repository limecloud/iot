package run.limeai.iot.device

import kotlin.test.*

class AudioStateTest {
    @Test fun percentages_follow_actual_discrete_indices_and_round_half_up() {
        val state = AudioState(0, 15, 1, false)
        assertEquals(1, state.indexFor(5)); assertEquals(7, state.percent)
        assertEquals(2, AudioState(0, 3, 0, false).indexFor(50))
        assertEquals(33, AudioState(0, 3, 1, false).percent)
        assertEquals(67, AudioState(0, 3, 2, false).percent)
        assertEquals(0, AudioState(0, 4, 0, false).indexFor(12))
        assertEquals(1, AudioState(0, 4, 0, false).indexFor(13))
    }

    @Test fun offsets_and_large_system_ranges_do_not_overflow() {
        val offset = AudioState(2, 17, 3, false)
        assertEquals(2, offset.indexFor(0)); assertEquals(17, offset.indexFor(100)); assertEquals(7, offset.percent)
        val large = AudioState(0, Int.MAX_VALUE, Int.MAX_VALUE, false)
        assertEquals(100, large.percent); assertEquals(1_073_741_824, large.indexFor(50))
        val high = AudioState(Int.MAX_VALUE - 10, Int.MAX_VALUE, Int.MAX_VALUE - 5, false)
        assertEquals(50, high.percent); assertEquals(Int.MAX_VALUE - 5, high.indexFor(50))
    }

    @Test fun all_percent_inputs_preserve_endpoints_bounds_and_monotonicity() {
        for (maximum in listOf(1, 2, 3, 15, 25, 100, 1000, Int.MAX_VALUE)) {
            val state = AudioState(0, maximum, 0, false)
            val indices = (0..100).map(state::indexFor)
            assertEquals(0, indices.first()); assertEquals(maximum, indices.last())
            assertTrue(indices.all { it in 0..maximum }); assertTrue(indices.zipWithNext().all { (left, right) -> left <= right })
        }
    }

    @Test fun invalid_ranges_indices_and_percentages_are_refused() {
        for ((minimum, maximum, index) in listOf(Triple(-1, 10, 0), Triple(0, 0, 0), Triple(5, 4, 5), Triple(0, 15, 16)))
            assertEquals("invalid_audio_state", assertFailsWith<DeviceFault> { AudioState(minimum, maximum, index, false) }.code)
        val state = AudioState(0, 15, 4, false)
        for (percent in listOf(Int.MIN_VALUE, -1, 101, Int.MAX_VALUE))
            assertEquals("invalid_audio_volume", assertFailsWith<DeviceFault> { state.indexFor(percent) }.code)
    }

    @Test fun zero_volume_and_mute_are_independent_system_observations() {
        assertFalse(AudioState(0, 15, 0, false).muted)
        val muted = AudioState(0, 15, 8, true)
        assertEquals(53, muted.percent); assertTrue(muted.muted)
    }
}
