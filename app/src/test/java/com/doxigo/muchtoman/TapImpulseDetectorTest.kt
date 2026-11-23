package com.doxigo.muchtoman

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TapImpulseDetectorTest {
    private val configuration = DoubleTapConfiguration()

    @Test
    fun zDominantImpulseIsAccepted() {
        val result = singleImpulse(x = 2f, z = 6f)
        assertTrue(result.toString(), result is TapImpulse.Accepted)
    }

    @Test
    fun impulseJustBelowDominanceRatioIsLateral() {
        // Lateral 5, Z 6: ratio 1.2 < 1.3.
        val result = singleImpulse(x = 5f, z = 6f)
        assertEquals(TapRejectionReason.LATERAL, (result as TapImpulse.Rejected).reason)
    }

    @Test
    fun impulseJustAboveDominanceRatioIsAccepted() {
        // Lateral 4, Z 6: ratio 1.5 ≥ 1.3.
        val result = singleImpulse(x = 4f, z = 6f)
        assertTrue(result.toString(), result is TapImpulse.Accepted)
    }

    @Test
    fun weakBlipIsTooWeak() {
        val result = singleImpulse(x = 0.5f, z = 2.2f)
        assertEquals(TapRejectionReason.TOO_WEAK, (result as TapImpulse.Rejected).reason)
    }

    @Test
    fun noImpulseWithoutThresholdCrossing() {
        val detector = TapImpulseDetector(configuration)
        var time = 0L
        repeat(400) {
            time += PERIOD
            assertNull(detector.onAcceleration(time, 0.3f, -0.2f, G + 0.5f))
        }
    }

    @Test
    fun impulseIsReportedAtWindowStartAfterTheWindowCloses() {
        val detector = TapImpulseDetector(configuration)
        var time = 0L
        repeat(100) { time += PERIOD; detector.onAcceleration(time, 0f, 0f, G) }
        val start = time + PERIOD
        val results = mutableListOf<TapImpulse>()
        listOf(6f, 3f, -2f, 0f, 0f, 0f, 0f, 0f, 0f).forEach { dz ->
            time += PERIOD
            detector.onAcceleration(time, 0f, 0f, G + dz)?.let(results::add)
        }
        assertEquals(1, results.size)
        assertEquals(start / 1_000_000L, results.single().timestampMs)
    }

    private fun singleImpulse(x: Float, z: Float): TapImpulse? {
        val detector = TapImpulseDetector(configuration)
        var time = 0L
        repeat(100) { time += PERIOD; detector.onAcceleration(time, 0f, 0f, G) }
        val results = mutableListOf<TapImpulse>()
        listOf(1f, 0.5f, 0f, 0f, 0f, 0f, 0f, 0f, 0f, 0f).forEach { factor ->
            time += PERIOD
            detector.onAcceleration(time, x * factor, 0f, G + z * factor)?.let(results::add)
        }
        return results.singleOrNull()
    }

    private companion object {
        const val G = 9.81f
        const val PERIOD = 5_000_000L
    }
}
