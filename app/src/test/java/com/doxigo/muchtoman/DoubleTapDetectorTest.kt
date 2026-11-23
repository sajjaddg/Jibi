package com.doxigo.muchtoman

import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Synthetic 200 Hz raw accelerometer streams (gravity included) driven through the full
 * Double Tap pipeline. Device held screen-up: gravity on +Z.
 */
class DoubleTapDetectorTest {
    private val configuration = DoubleTapConfiguration()

    @Test
    fun twoCleanBackTapsInsideWindowTrigger() {
        for (gapMs in listOf(120L, 200L, 300L)) {
            val run = Run()
            run.still(600)
            run.backTap()
            run.still(gapMs - TAP_DURATION_MS)
            run.backTap()
            run.still(300)
            assertEquals("gap=$gapMs events=${run.events}", 1, run.doubleTaps)
            assertEquals("gap=$gapMs", 2, run.impulses)
        }
    }

    @Test
    fun backTapsWhileHoldingThePhoneWithHandTremorTrigger() {
        val run = Run()
        val random = Random(42)
        run.noise = { (random.nextFloat() - 0.5f) * 0.5f }
        run.still(800)
        run.backTap()
        run.still(220 - TAP_DURATION_MS)
        run.backTap()
        run.still(300)
        assertEquals(run.events.toString(), 1, run.doubleTaps)
    }

    @Test
    fun doubleTapFiresOnlyAfterTheQuietConfirmation() {
        val run = Run()
        run.still(600)
        run.backTap()
        run.still(180 - TAP_DURATION_MS)
        run.backTap()
        run.still(100)
        assertEquals("must wait for quiet", 0, run.doubleTaps)
        run.still(200)
        assertEquals(1, run.doubleTaps)
    }

    @Test
    fun threeQuickTapsAreATapSeriesNotADoubleTap() {
        val run = Run()
        run.still(600)
        repeat(3) {
            run.backTap()
            run.still(170 - TAP_DURATION_MS)
        }
        run.still(500)
        assertEquals(run.events.toString(), 0, run.doubleTaps)
        assertTrue(run.rejections(TapRejectionReason.TAP_SERIES) >= 1)
    }

    @Test
    fun continuousTapTrainNeverTriggers() {
        val run = Run()
        run.still(600)
        repeat(12) {
            run.backTap()
            run.still(170 - TAP_DURATION_MS)
        }
        run.still(500)
        assertEquals(run.events.toString(), 0, run.doubleTaps)
    }

    @Test
    fun singleTapDoesNotTrigger() {
        val run = Run()
        run.still(600)
        run.backTap()
        run.still(1_000)
        assertEquals(1, run.impulses)
        assertEquals(0, run.doubleTaps)
    }

    @Test
    fun tapsTooFarApartDoNotTrigger() {
        val run = Run()
        run.still(600)
        run.backTap()
        run.still(500)
        run.backTap()
        run.still(300)
        assertEquals(2, run.impulses)
        assertEquals(0, run.doubleTaps)
    }

    @Test
    fun ringDownOfOneTapIsNotASecondTap() {
        val run = Run()
        run.still(600)
        // Strong tap followed by a slowly decaying oscillation lasting ~150 ms.
        var amplitude = 7f
        var sign = 1f
        while (amplitude > 0.5f) {
            run.sample(z = G + sign * amplitude)
            sign = -sign
            amplitude *= 0.94f
        }
        run.still(800)
        assertEquals(run.events.toString(), 1, run.impulses)
        assertEquals(0, run.doubleTaps)
    }

    @Test
    fun ringDownWithSecondaryBounceInsideRefractoryIsIgnored() {
        val run = Run()
        run.still(600)
        run.backTap()
        run.still(30)
        // Rebound bump 50 ms after the tap: inside the refractory period.
        run.sample(z = G + 4f)
        run.sample(z = G - 2f)
        run.still(600)
        assertEquals(run.events.toString(), 1, run.impulses)
        assertEquals(0, run.doubleTaps)
    }

    @Test
    fun lateralBumpsAreRejected() {
        val run = Run()
        run.still(600)
        run.impulse(x = 6f, z = 2.6f)
        run.still(180)
        run.impulse(x = -6f, z = 2.6f)
        run.still(300)
        assertEquals(0, run.doubleTaps)
        assertTrue(run.rejections(TapRejectionReason.LATERAL) >= 2)
    }

    @Test
    fun screenTapsAreRejected() {
        val run = Run()
        run.still(600)
        run.impulse(z = -6f)
        run.still(180)
        run.impulse(z = -6f)
        run.still(300)
        assertEquals(0, run.doubleTaps)
        assertEquals(2, run.rejections(TapRejectionReason.SCREEN_SIDE))
    }

    @Test
    fun puttingThePhoneDownHardIsRejected() {
        val run = Run()
        run.still(600)
        run.impulse(z = 40f)
        run.still(180)
        run.impulse(z = 38f)
        run.still(300)
        assertEquals(0, run.doubleTaps)
        assertEquals(2, run.rejections(TapRejectionReason.TOO_STRONG))
    }

    @Test
    fun walkingWithHeelStrikesDoesNotTrigger() {
        val run = Run()
        run.still(600)
        // ~1.9 steps/s: body bounce plus a sharp Z heel-strike spike every step.
        run.periodicMotion(durationMs = 6_000, frequencyHz = 1.9f, amplitude = 2.5f, spikeEveryMs = 260, spike = 6f)
        assertEquals(run.events.toString(), 0, run.doubleTaps)
    }

    @Test
    fun runningDoesNotTrigger() {
        val run = Run()
        run.still(600)
        // Running cadence ~2.8 Hz with spikes ~180 ms apart, inside the pairing window.
        run.periodicMotion(durationMs = 6_000, frequencyHz = 2.8f, amplitude = 5f, spikeEveryMs = 180, spike = 9f)
        assertEquals(run.events.toString(), 0, run.doubleTaps)
    }

    @Test
    fun abruptJoltTrainWithoutLeadInDoesNotTrigger() {
        val run = Run()
        run.still(600)
        // Rhythmic jolts every 220 ms with no motion between them (e.g. vehicle chatter).
        repeat(20) {
            run.impulse(z = 6f)
            run.still(220 - TAP_DURATION_MS)
        }
        assertEquals(run.events.toString(), 0, run.doubleTaps)
    }

    @Test
    fun joggingAtRealCadenceDoesNotTrigger() {
        val run = Run()
        run.still(600)
        // ~176 steps/min: steps 340 ms apart, inside the pairing window, with body motion between.
        run.periodicMotion(durationMs = 6_000, frequencyHz = 2.94f, amplitude = 4f, spikeEveryMs = 340, spike = 8f)
        assertEquals(run.events.toString(), 0, run.doubleTaps)
    }

    @Test
    fun vehicleVibrationWithBumpsDoesNotTrigger() {
        val run = Run()
        run.still(600)
        run.periodicMotion(durationMs = 4_000, frequencyHz = 9f, amplitude = 1.6f, spikeEveryMs = 200, spike = 5f)
        assertEquals(run.events.toString(), 0, run.doubleTaps)
    }

    @Test
    fun rotationDuringImpulseIsRejectedWhenGyroscopeIsPresent() {
        val run = Run()
        run.still(600)
        run.rotation = 3f
        run.backTap()
        run.still(160)
        run.backTap()
        run.still(300)
        assertEquals(0, run.doubleTaps)
        assertEquals(2, run.rejections(TapRejectionReason.ROTATION))
    }

    @Test
    fun smallRotationFromHoldingThePhoneIsAccepted() {
        val run = Run()
        run.still(600)
        run.rotation = 0.4f
        run.backTap()
        run.still(160)
        run.backTap()
        run.still(300)
        assertEquals(1, run.doubleTaps)
    }

    @Test
    fun cooldownBlocksImmediateRepeatAndRearmsAfterwards() {
        val run = Run()
        run.still(600)
        run.doubleTap()
        assertEquals(1, run.doubleTaps)

        run.still(300)
        run.doubleTap()
        assertEquals(1, run.doubleTaps)
        assertTrue(run.rejections(TapRejectionReason.COOLDOWN) >= 1)

        run.still(1_500)
        run.doubleTap()
        assertEquals(2, run.doubleTaps)
    }

    @Test
    fun bumpBetweenTapsCancelsThePendingFirstTap() {
        val run = Run()
        run.still(600)
        run.backTap()
        run.still(100)
        run.impulse(x = 7f, z = 1f)
        run.still(90)
        run.backTap()
        run.still(300)
        assertEquals(0, run.doubleTaps)
    }

    @Test
    fun sensorGapResetsFiltersWithoutAFalseImpulse() {
        val run = Run()
        run.still(600)
        run.skip(2_000)
        // Device was reoriented during the gap: gravity now on Y.
        repeat(100) { run.sample(y = G, z = 0f) }
        assertEquals(run.events.toString(), 0, run.events.size)
    }

    @Test
    fun orientationChangeIsNotATap() {
        val run = Run()
        run.still(600)
        // Rotate gravity from Z to Y over 400 ms (picking the phone up).
        val steps = 80
        repeat(steps) { step ->
            val angle = (step + 1) / steps.toFloat() * (PI / 2).toFloat()
            run.sample(y = G * sin(angle), z = G * kotlin.math.cos(angle))
        }
        run.still(400)
        assertEquals(0, run.doubleTaps)
        assertEquals(0, run.impulses)
    }

    private inner class Run {
        private var timeNanos = 1_000_000_000L
        val events = mutableListOf<TapDetectorEvent>()
        var rotation = 0f
        var noise: () -> Float = { 0f }
        private val detector = DoubleTapDetector(configuration) { events += it }

        val doubleTaps get() = events.count { it is TapDetectorEvent.DoubleTap }
        val impulses get() = events.count { it is TapDetectorEvent.Impulse }
        fun rejections(reason: TapRejectionReason) =
            events.count { it is TapDetectorEvent.Rejected && it.reason == reason }

        fun sample(x: Float = 0f, y: Float = 0f, z: Float = G) {
            timeNanos += SAMPLE_PERIOD_NANOS
            if (rotation > 0f) detector.onRotationRate(timeNanos, rotation, 0f, 0f)
            detector.onAcceleration(timeNanos, x + noise(), y + noise(), z + noise())
        }

        fun still(durationMs: Long) = repeat((durationMs / SAMPLE_PERIOD_MS).toInt()) { sample() }

        fun skip(durationMs: Long) {
            timeNanos += durationMs * 1_000_000L
        }

        /** A clean knock on the back: sharp +Z spike, short rebound, small lateral component. */
        fun backTap() {
            sample(x = 0.8f, z = G + 6f)
            sample(x = -0.6f, z = G + 3f)
            sample(x = 0.3f, z = G - 2.5f)
            sample(z = G + 1f)
        }

        fun doubleTap() {
            backTap()
            still(180 - TAP_DURATION_MS)
            backTap()
            still(300)
        }

        fun impulse(x: Float = 0f, z: Float) {
            sample(x = x, z = G + z)
            sample(x = x * 0.5f, z = G + z * 0.5f)
            sample(x = -x * 0.3f, z = G - z * 0.3f)
            sample()
        }

        fun periodicMotion(durationMs: Long, frequencyHz: Float, amplitude: Float, spikeEveryMs: Long, spike: Float) {
            val samples = (durationMs / SAMPLE_PERIOD_MS).toInt()
            val spikeEvery = (spikeEveryMs / SAMPLE_PERIOD_MS).toInt()
            for (index in 0 until samples) {
                val t = index * SAMPLE_PERIOD_MS / 1_000f
                val wave = amplitude * sin(2 * PI.toFloat() * frequencyHz * t)
                // Body motion precedes the first jolt by half a step, as in real walking.
                val heel = if (index % spikeEvery == spikeEvery / 2) spike else 0f
                sample(
                    x = 0.4f * wave,
                    y = 0.6f * wave,
                    z = G + wave + heel,
                )
            }
        }
    }

    private companion object {
        const val G = 9.81f
        const val SAMPLE_PERIOD_MS = 5L
        const val SAMPLE_PERIOD_NANOS = SAMPLE_PERIOD_MS * 1_000_000L
        const val TAP_DURATION_MS = 4 * SAMPLE_PERIOD_MS
    }
}
