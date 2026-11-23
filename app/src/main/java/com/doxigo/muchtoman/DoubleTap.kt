package com.doxigo.muchtoman

// «دو ضربه پشت گوشی» — two knocks on the back of the phone open «تراکنش دستی» from wherever she
// is. This file is the pure half: accepted single taps (TapImpulse.kt) paired into one gesture.
// Plain JVM on purpose, so every threshold is under test without a sensor. The Android half —
// the sensor listener, the foreground service that keeps it listening, and what a double tap
// opens — is DoubleTapService.kt.

/**
 * Every Double Tap (back tap) threshold lives here. Accelerations are in m/s² of the
 * high-pass filtered raw accelerometer signal; rotation is in rad/s; times are in ms.
 *
 * Tuned on a real 200 Hz recording (Xiaomi, HyperOS 3 / Android 16, phone held in hand):
 * back taps Z 4–12 m/s² with lateral 1–2.5, rotation < 1 rad/s, ring-down ≈ 0.8 m/s² for
 * 80–150 ms, tap gaps 150–375 ms. There is intentionally no "phone was moving" check: on that
 * device it rejected too many real taps; trains of knocks are rejected by the quiet rules.
 *
 * Carried over unchanged from the Jibi prototype, where it was tuned; DoubleTapDetectorTest pins
 * the behaviour. Re-tune against the debug log [DoubleTapListener] writes (`adb logcat -s
 * muchtoman-tap`), never by feel on one phone.
 */
data class DoubleTapConfiguration(
    // Signal conditioning.
    /** Time constant of the gravity low-pass; the high-pass cutoff is ≈ 1 / (2π·τ) ≈ 1.3 Hz. */
    val gravityFilterTimeConstantMs: Float = 120f,
    /** Sensor gaps longer than this (batching, suspend) reset the filters instead of producing a spike. */
    val sampleGapResetMs: Long = 250,

    // Impulse shape.
    /** High-passed magnitude that opens an impulse window. */
    val impulseOpenThreshold: Float = 2.0f,
    /** Minimum Z (perpendicular to screen) peak for a tap. */
    val minimumZPeak: Float = 2.2f,
    /** Anything stronger is a drop, slam or the phone being put down. */
    val maximumImpulsePeak: Float = 30f,
    /** Z peak must be at least this multiple of the lateral (X/Y) peak. */
    val zDominanceRatio: Float = 1.3f,
    /**
     * A tap on the back pushes the device toward +Z (out of the screen); a tap on the screen
     * pushes it toward -Z. When true, impulses whose first significant Z swing is negative are
     * rejected so screen taps and typing do not count.
     */
    val rejectScreenSideImpulses: Boolean = true,
    /** How long after the first threshold crossing peaks are collected before deciding. */
    val impulseWindowMs: Long = 30,
    /** Minimum dead time after an impulse so its ring-down is never counted as another tap. */
    val refractoryMs: Long = 80,
    /** After the refractory period the signal must drop below this before re-arming. */
    val releaseThreshold: Float = 1.0f,

    // Context filters.
    /** Gyroscope rate above this during the impulse rejects it. Ignored without a gyroscope. */
    val maximumRotationRate: Float = 1.5f,
    /** A gyroscope sample older than this when an impulse starts is ignored. */
    val rotationStalenessMs: Long = 60,

    // Tap pairing.
    val minimumTapIntervalMs: Long = 90,
    val maximumTapIntervalMs: Long = 360,
    val cooldownMs: Long = 1_200,
    /**
     * After the second tap, no further knock may start within this long or the pair is treated
     * as part of a train (walking, running, vehicle) and dropped. Adds this much latency.
     */
    val confirmationQuietMs: Long = 250,
    /** A knock can only start a pair if no other knock came within this long before it. */
    val leadingQuietMs: Long = 300,
)

enum class DoubleTapDecision {
    /** Stored as the first tap of a possible pair. */
    FIRST_TAP,
    /** Second tap inside the window: the gesture fired. */
    TRIGGERED,
    /** Second tap came faster than a human double tap; ignored, first tap kept. */
    TOO_SOON,
    /** A gesture fired recently; tap ignored. */
    COOLDOWN,
}

/** Pairs accepted tap impulses into a double tap. Pure JVM; timestamps in ms. */
class DoubleTapGestureProcessor(private val configuration: DoubleTapConfiguration) {
    private var firstTapAt: Long? = null
    private var cooldownUntil = Long.MIN_VALUE

    fun onTap(timestampMs: Long): DoubleTapDecision {
        if (timestampMs < cooldownUntil) return DoubleTapDecision.COOLDOWN
        val first = firstTapAt
        if (first == null) {
            firstTapAt = timestampMs
            return DoubleTapDecision.FIRST_TAP
        }

        val interval = timestampMs - first
        if (interval < configuration.minimumTapIntervalMs) return DoubleTapDecision.TOO_SOON
        if (interval > configuration.maximumTapIntervalMs) {
            firstTapAt = timestampMs
            return DoubleTapDecision.FIRST_TAP
        }

        firstTapAt = null
        cooldownUntil = timestampMs + configuration.cooldownMs
        return DoubleTapDecision.TRIGGERED
    }

    val hasPendingTap: Boolean get() = firstTapAt != null

    fun processTap(timestampMs: Long): Boolean = onTap(timestampMs) == DoubleTapDecision.TRIGGERED

    /** Forget a pending first tap, e.g. after an unrelated bump between the two taps. */
    fun cancelPending() {
        firstTapAt = null
    }

    fun reset() {
        firstTapAt = null
        cooldownUntil = Long.MIN_VALUE
    }
}

/** Decisions the Double Tap pipeline makes; used for the gesture, diagnostics and debug logs. */
sealed interface TapDetectorEvent {
    val timestampMs: Long

    /** A single tap impulse passed every filter. */
    data class Impulse(override val timestampMs: Long, val metrics: ImpulseMetrics) : TapDetectorEvent

    data class Rejected(
        override val timestampMs: Long,
        val reason: TapRejectionReason,
        val metrics: ImpulseMetrics,
    ) : TapDetectorEvent

    /** Fired after the quiet confirmation; [timestampMs] is the second tap. */
    data class DoubleTap(override val timestampMs: Long) : TapDetectorEvent
}

/**
 * Raw accelerometer (+ optional gyroscope) samples in, [TapDetectorEvent]s out.
 * Pure JVM: wires [TapImpulseDetector] to [DoubleTapGestureProcessor].
 */
class DoubleTapDetector(
    private val configuration: DoubleTapConfiguration,
    private val onEvent: (TapDetectorEvent) -> Unit,
) {
    private val impulseDetector = TapImpulseDetector(configuration)
    private val pairing = DoubleTapGestureProcessor(configuration)

    /** Second tap of a pair waiting for [DoubleTapConfiguration.confirmationQuietMs] of quiet. */
    private var pendingSecondTapMs: Long? = null

    /** Start of the most recent knock (any impulse except a too-weak blip). */
    private var lastKnockMs = Long.MIN_VALUE

    fun onAcceleration(timestampNanos: Long, x: Float, y: Float, z: Float) {
        val impulse = impulseDetector.onAcceleration(timestampNanos, x, y, z)
        val sampleMs = timestampNanos / NANOS_PER_MILLISECOND

        // Walking, running and vehicle bumps are trains of knocks; a deliberate double tap is
        // exactly two followed by quiet. A third knock inside the quiet window cancels the pair.
        var reportedAsSeries = false
        val pending = pendingSecondTapMs
        if (pending != null && impulse != null &&
            impulse.timestampMs < pending + configuration.confirmationQuietMs &&
            !(impulse is TapImpulse.Rejected && impulse.reason == TapRejectionReason.TOO_WEAK)
        ) {
            pendingSecondTapMs = null
            pairing.reset()
            reportedAsSeries = true
            onEvent(TapDetectorEvent.Rejected(impulse.timestampMs, TapRejectionReason.TAP_SERIES, impulse.metrics))
        }
        // Wait one impulse window past the quiet period so a knock that started inside it is judged.
        val confirmed = pendingSecondTapMs
        if (confirmed != null &&
            sampleMs >= confirmed + configuration.confirmationQuietMs + configuration.impulseWindowMs
        ) {
            pendingSecondTapMs = null
            onEvent(TapDetectorEvent.DoubleTap(confirmed))
        }

        val previousKnockMs = lastKnockMs
        if (impulse != null && !(impulse is TapImpulse.Rejected && impulse.reason == TapRejectionReason.TOO_WEAK)) {
            lastKnockMs = impulse.timestampMs
        }

        when (impulse) {
            null -> Unit
            is TapImpulse.Rejected -> {
                // A real bump between taps breaks the pair; a too-weak blip does not.
                if (impulse.reason != TapRejectionReason.TOO_WEAK) pairing.cancelPending()
                onEvent(TapDetectorEvent.Rejected(impulse.timestampMs, impulse.reason, impulse.metrics))
            }
            is TapImpulse.Accepted -> {
                if (!reportedAsSeries) onEvent(TapDetectorEvent.Impulse(impulse.timestampMs, impulse.metrics))
                val inTrain = previousKnockMs != Long.MIN_VALUE &&
                    impulse.timestampMs - previousKnockMs < configuration.leadingQuietMs
                if (!pairing.hasPendingTap && inTrain) {
                    // Would be a first tap, but it follows another knock too closely.
                    if (!reportedAsSeries) {
                        onEvent(TapDetectorEvent.Rejected(impulse.timestampMs, TapRejectionReason.TAP_SERIES, impulse.metrics))
                    }
                    return
                }
                when (pairing.onTap(impulse.timestampMs)) {
                    DoubleTapDecision.FIRST_TAP -> Unit
                    DoubleTapDecision.TRIGGERED -> pendingSecondTapMs = impulse.timestampMs
                    DoubleTapDecision.TOO_SOON -> onEvent(
                        TapDetectorEvent.Rejected(impulse.timestampMs, TapRejectionReason.TOO_SOON, impulse.metrics),
                    )
                    DoubleTapDecision.COOLDOWN -> onEvent(
                        TapDetectorEvent.Rejected(impulse.timestampMs, TapRejectionReason.COOLDOWN, impulse.metrics),
                    )
                }
            }
        }
    }

    fun onRotationRate(timestampNanos: Long, x: Float, y: Float, z: Float) {
        impulseDetector.onRotationRate(timestampNanos, x, y, z)
    }

    fun reset() {
        impulseDetector.reset()
        pairing.reset()
        pendingSecondTapMs = null
        lastKnockMs = Long.MIN_VALUE
    }

    private companion object {
        const val NANOS_PER_MILLISECOND = 1_000_000L
    }
}
