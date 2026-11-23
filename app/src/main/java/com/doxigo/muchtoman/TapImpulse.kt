package com.doxigo.muchtoman

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

enum class TapRejectionReason {
    /** Crossed the open threshold but the Z peak was too small. */
    TOO_WEAK,
    /** Drop, slam or putting the phone down. */
    TOO_STRONG,
    /** Mostly X/Y: a side bump rather than a back tap. */
    LATERAL,
    /** First Z swing toward -Z: a tap on the screen, not the back. */
    SCREEN_SIDE,
    /** Gyroscope saw the device rotating during the impulse. */
    ROTATION,
    /** Pairing: second impulse faster than a human double tap. */
    TOO_SOON,
    /** Pairing: a gesture fired recently. */
    COOLDOWN,
    /** Pairing: more than two knocks in a row; a train of knocks (walking, running, bumps). */
    TAP_SERIES,
}

data class ImpulseMetrics(
    val peakZ: Float,
    val peakLateral: Float,
    val peakMagnitude: Float,
    val firstZSign: Int,
    val peakRotation: Float,
)

sealed interface TapImpulse {
    val timestampMs: Long
    val metrics: ImpulseMetrics

    data class Accepted(override val timestampMs: Long, override val metrics: ImpulseMetrics) : TapImpulse

    data class Rejected(
        override val timestampMs: Long,
        val reason: TapRejectionReason,
        override val metrics: ImpulseMetrics,
    ) : TapImpulse
}

/**
 * Finds single back-tap impulses in a raw accelerometer stream. Pure JVM so it can be unit
 * tested without android.hardware.
 *
 * Pipeline per sample:
 * 1. A time-constant low-pass tracks gravity; raw − gravity is the high-passed signal, which
 *    keeps the sharp few-millisecond tap spike that fused linear acceleration smooths away.
 * 2. When the high-passed magnitude crosses [DoubleTapConfiguration.impulseOpenThreshold], peaks
 *    are collected for [DoubleTapConfiguration.impulseWindowMs], then the impulse is judged only
 *    on its own shape: strength, Z dominance, Z sign, and gyroscope rotation. Whether the phone
 *    was moving beforehand is deliberately not judged; trains of knocks from walking or vehicles
 *    are rejected by [DoubleTapDetector] instead.
 * 3. After any impulse the detector stays disarmed for the refractory period and until the
 *    signal releases, so ring-down never becomes a second tap.
 */
class TapImpulseDetector(private val configuration: DoubleTapConfiguration) {
    private val gravity = FloatArray(3)
    private var initialized = false
    private var lastTimestampNanos = 0L

    private var latestRotation = 0f
    private var latestRotationAtNanos = Long.MIN_VALUE

    private var windowOpen = false
    private var windowStartNanos = 0L
    private var peakZ = 0f
    private var peakLateral = 0f
    private var peakMagnitude = 0f
    private var peakRotation = 0f
    private var firstZSign = 0

    private var armed = true
    private var refractoryUntilNanos = Long.MIN_VALUE

    fun onRotationRate(timestampNanos: Long, x: Float, y: Float, z: Float) {
        val rate = sqrt(x * x + y * y + z * z)
        latestRotation = rate
        latestRotationAtNanos = timestampNanos
        if (windowOpen && timestampNanos >= windowStartNanos - msToNanos(configuration.rotationStalenessMs)) {
            peakRotation = max(peakRotation, rate)
        }
    }

    fun onAcceleration(timestampNanos: Long, x: Float, y: Float, z: Float): TapImpulse? {
        if (!initialized || timestampNanos - lastTimestampNanos > msToNanos(configuration.sampleGapResetMs)) {
            restartFilters(timestampNanos, x, y, z)
            return null
        }
        val dtNanos = timestampNanos - lastTimestampNanos
        if (dtNanos <= 0) return null
        lastTimestampNanos = timestampNanos
        val dtSeconds = dtNanos / NANOS_PER_SECOND

        val gravityAlpha = alpha(dtSeconds, configuration.gravityFilterTimeConstantMs)
        gravity[0] += gravityAlpha * (x - gravity[0])
        gravity[1] += gravityAlpha * (y - gravity[1])
        gravity[2] += gravityAlpha * (z - gravity[2])
        val hx = x - gravity[0]
        val hy = y - gravity[1]
        val hz = z - gravity[2]
        val lateral = sqrt(hx * hx + hy * hy)
        val magnitude = sqrt(lateral * lateral + hz * hz)

        if (windowOpen) {
            collect(hz, lateral, magnitude)
            return if (timestampNanos - windowStartNanos >= msToNanos(configuration.impulseWindowMs)) {
                closeWindow()
            } else {
                null
            }
        }

        if (!armed && timestampNanos >= refractoryUntilNanos && magnitude < configuration.releaseThreshold) {
            armed = true
        }
        if (armed && magnitude >= configuration.impulseOpenThreshold) {
            openWindow(timestampNanos)
            collect(hz, lateral, magnitude)
        }
        return null
    }

    fun reset() {
        initialized = false
        latestRotation = 0f
        latestRotationAtNanos = Long.MIN_VALUE
        windowOpen = false
        armed = true
        refractoryUntilNanos = Long.MIN_VALUE
    }

    private fun restartFilters(timestampNanos: Long, x: Float, y: Float, z: Float) {
        reset()
        gravity[0] = x
        gravity[1] = y
        gravity[2] = z
        lastTimestampNanos = timestampNanos
        initialized = true
    }

    private fun openWindow(timestampNanos: Long) {
        windowOpen = true
        windowStartNanos = timestampNanos
        peakZ = 0f
        peakLateral = 0f
        peakMagnitude = 0f
        firstZSign = 0
        val rotationFresh = latestRotationAtNanos != Long.MIN_VALUE &&
            timestampNanos - latestRotationAtNanos <= msToNanos(configuration.rotationStalenessMs)
        peakRotation = if (rotationFresh) latestRotation else 0f
        armed = false
        refractoryUntilNanos = timestampNanos + msToNanos(configuration.refractoryMs)
    }

    private fun collect(hz: Float, lateral: Float, magnitude: Float) {
        val absZ = abs(hz)
        peakZ = max(peakZ, absZ)
        peakLateral = max(peakLateral, lateral)
        peakMagnitude = max(peakMagnitude, magnitude)
        if (firstZSign == 0 && absZ >= configuration.minimumZPeak * Z_SIGN_FRACTION) {
            firstZSign = if (hz > 0f) 1 else -1
        }
    }

    private fun closeWindow(): TapImpulse {
        windowOpen = false
        val metrics = ImpulseMetrics(
            peakZ = peakZ,
            peakLateral = peakLateral,
            peakMagnitude = peakMagnitude,
            firstZSign = firstZSign,
            peakRotation = peakRotation,
        )
        val timestampMs = windowStartNanos / NANOS_PER_MILLISECOND
        val reason = rejectionReason(metrics)
        return if (reason == null) {
            TapImpulse.Accepted(timestampMs, metrics)
        } else {
            TapImpulse.Rejected(timestampMs, reason, metrics)
        }
    }

    private fun rejectionReason(metrics: ImpulseMetrics): TapRejectionReason? = when {
        metrics.peakMagnitude > configuration.maximumImpulsePeak -> TapRejectionReason.TOO_STRONG
        // A strong side bump is LATERAL even when its Z part is small, so it breaks a pending pair.
        metrics.peakZ < configuration.zDominanceRatio * metrics.peakLateral &&
            max(metrics.peakZ, metrics.peakLateral) >= configuration.minimumZPeak -> TapRejectionReason.LATERAL
        metrics.peakZ < configuration.minimumZPeak -> TapRejectionReason.TOO_WEAK
        configuration.rejectScreenSideImpulses && metrics.firstZSign < 0 -> TapRejectionReason.SCREEN_SIDE
        metrics.peakRotation > configuration.maximumRotationRate -> TapRejectionReason.ROTATION
        else -> null
    }

    private fun alpha(dtSeconds: Float, timeConstantMs: Float): Float {
        val tau = timeConstantMs / 1_000f
        return min(1f, dtSeconds / (tau + dtSeconds))
    }

    private fun msToNanos(ms: Long): Long = ms * NANOS_PER_MILLISECOND

    private companion object {
        const val NANOS_PER_MILLISECOND = 1_000_000L
        const val NANOS_PER_SECOND = 1_000_000_000f
        /** The first Z sample at half the minimum peak decides which side was hit. */
        const val Z_SIGN_FRACTION = 0.5f
    }
}
