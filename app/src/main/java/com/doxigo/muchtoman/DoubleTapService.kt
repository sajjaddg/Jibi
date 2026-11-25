package com.doxigo.muchtoman

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

// The Android half of «دو ضربه پشت گوشی» — see DoubleTap.kt for the pure half and what it decides.
//
// Two knocks open [QuickEntryActivity]: a translucent, isolated window showing only «تراکنش دستی»
// (ManualTxnSheet) directly over whatever app or screen she is on, without opening MainActivity or
// leaving her inside the app afterwards. Because it is still a real FragmentActivity of this app,
// it shares the same ManualTxnSheet UI, app lock, categories, accounts, and [persistManualTxn] save
// path with zero duplicated form code.
//
// What the overlay permission buys is the launch itself. Android 10+ refuses to start an activity
// from the background, and «نمایش روی برنامه‌های دیگر» (SYSTEM_ALERT_WINDOW) is the exemption a
// user can grant. So the switch asks for it, and the service will not run without it: a gesture
// that is heard and then silently refused reads as a gesture that does not work.

/** Whether every piece the gesture needs is in place: her switch, the permission, the full app. */
fun doubleTapWanted(context: Context): Boolean =
    !BuildConfig.LITE && Store(context).doubleTap && canOpenOverApps(context)

/** «نمایش روی برنامه‌های دیگر» — granted only on Android's own page, never by a dialog. */
fun canOpenOverApps(context: Context): Boolean = Settings.canDrawOverlays(context)

/** Android's page for that permission, opened on this app where the phone allows it. */
fun askOpenOverApps(context: Context): Boolean {
    val direct = Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.fromParts("package", context.packageName, null),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (runCatching { context.startActivity(direct) }.isSuccess) return true
    val list = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return runCatching { context.startActivity(list) }.isSuccess
}

/**
 * Xiaomi's own second gate on top of Android's: «نمایش پنجره‌های بازشو هنگام اجرا در پس‌زمینه»,
 * off by default on MIUI and HyperOS, and without it the launch is dropped without a word even with
 * the overlay permission held. It has no public API to read, so the page only names it on a Xiaomi
 * phone and offers MIUI's permission editor, falling back to the app's own info page.
 */
fun isXiaomi(): Boolean =
    Build.MANUFACTURER.equals("Xiaomi", ignoreCase = true) ||
        Build.BRAND.equals("Redmi", ignoreCase = true) ||
        Build.BRAND.equals("POCO", ignoreCase = true)

fun openXiaomiPermissions(context: Context): Boolean {
    val editor = Intent("miui.intent.action.APP_PERM_EDITOR")
        .putExtra("extra_pkgname", context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (runCatching { context.startActivity(editor) }.isSuccess) return true
    val info = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.fromParts("package", context.packageName, null),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return runCatching { context.startActivity(info) }.isSuccess
}

/**
 * Start the listening service when [doubleTapWanted], stop it otherwise. Idempotent, so every place
 * that might have changed the answer just calls it: the switch, a return from Android's permission
 * page, the app opening, a reboot. Never throws — Android 12+ refuses a foreground start from the
 * background, and that refusal is a "not now", retried the next time the app opens.
 */
fun refreshDoubleTap(context: Context): Boolean {
    // Lite declares no service at all (src/full/AndroidManifest.xml), so there is nothing to stop.
    if (BuildConfig.LITE) return true
    val app = context.applicationContext
    val intent = Intent(app, DoubleTapService::class.java)
    if (!doubleTapWanted(app)) {
        app.stopService(intent)
        return true
    }
    return try {
        ContextCompat.startForegroundService(app, intent)
        true
    } catch (e: IllegalStateException) {
        // ForegroundServiceStartNotAllowedException is one of these, and only exists on API 31+.
        logFailure("double tap service start", e)
        false
    } catch (e: SecurityException) {
        logFailure("double tap service start", e)
        false
    }
}

/**
 * What a double tap does: open [QuickEntryActivity] directly over whatever screen is active,
 * without bringing [MainActivity] to the front.
 */
internal fun openQuickEntry(context: Context): Boolean {
    val intent = quickEntryIntent(context)
    return runCatching { context.startActivity(intent) }
        .onFailure { logFailure("double tap launch", it) }
        .isSuccess
}

internal fun quickEntryIntent(context: Context): Intent =
    Intent(context, QuickEntryActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)

/**
 * Keeps the accelerometer listened to while the app is closed. A foreground service because nothing
 * else may hold a sensor in the background, and that is also why its note is in the shade for as
 * long as the switch is on: Android requires one, and it is the honest answer to «why is this
 * running». The channel is IMPORTANCE_MIN, so it sits folded at the bottom and makes no sound.
 */
class DoubleTapService : Service() {
    private var listener: DoubleTapListener? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureDoubleTapChannel(this)
        val note = NotificationCompat.Builder(this, DOUBLE_TAP_CHANNEL)
            .setSmallIcon(R.drawable.ic_toman)
            .setColor(0xFF0A423B.toInt())
            .setContentTitle("دو ضربه پشت گوشی روشنه")
            .setContentText("دو بار بزن پشت گوشی تا تراکنش دستی باز بشه.")
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openFromWidget(this))
            .build()
        try {
            ServiceCompat.startForeground(
                this,
                DOUBLE_TAP_NOTE_ID,
                note,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                } else {
                    0
                },
            )
        } catch (e: IllegalStateException) {
            logFailure("double tap foreground", e)
            stopSelf()
            return START_NOT_STICKY
        } catch (e: SecurityException) {
            logFailure("double tap foreground", e)
            stopSelf()
            return START_NOT_STICKY
        }
        // Checked only after startForeground: a service started with startForegroundService that
        // stops without promoting itself first is a crash on Android 8+, not a quiet no-op. This is
        // a sticky restart, or a start that raced her switching it off or revoking the permission.
        if (!doubleTapWanted(this)) {
            stopSelf()
            return START_NOT_STICKY
        }

        if (listener == null) {
            val sensors = getSystemService(SensorManager::class.java)
            val started = sensors?.let { manager ->
                DoubleTapListener(manager) { openQuickEntry(applicationContext) }.takeIf { it.start() }
            }
            if (started == null) {
                // No accelerometer, or one that refused to register: nothing to listen with.
                stopSelf()
                return START_NOT_STICKY
            }
            listener = started
        }
        return START_STICKY
    }

    override fun onDestroy() {
        listener?.stop()
        listener = null
        super.onDestroy()
    }
}

/**
 * Restarts the service after a reboot or an update to the app, if she had it on. BOOT_COMPLETED
 * and MY_PACKAGE_REPLACED are both on Android's list of moments a foreground service may start
 * from the background. Synchronous: [Store] is SharedPreferences, read in microseconds.
 */
class DoubleTapBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            refreshDoubleTap(context)
        }
    }
}

/**
 * The sensors, on a thread of their own; [onDoubleTap] is called on the main thread.
 *
 * The raw accelerometer at 200 Hz, not linear acceleration: the fused sensor smooths away exactly
 * the few-millisecond spike a knock is. 200 Hz is the most Android 12+ gives without
 * HIGH_SAMPLING_RATE_SENSORS — and never SENSOR_DELAY_FASTEST, which throws a SecurityException in
 * a debuggable build there (the crash Jibi shipped once). The gyroscope is optional: without one, a
 * knock while the phone is turning is not rejected, and everything else still works.
 */
private class DoubleTapListener(
    private val sensors: SensorManager,
    private val onDoubleTap: () -> Unit,
) : SensorEventListener {
    private val main = Handler(Looper.getMainLooper())
    private var thread: HandlerThread? = null
    @Volatile private var running = false

    private val detector = DoubleTapDetector(DoubleTapConfiguration()) { event ->
        // Decisions only, never samples, and only on a debug build: the line to read when
        // retuning on a phone the thresholds were not set on.
        if (BuildConfig.DEBUG) Log.d(TAP_LOG, event.toString())
        if (event is TapDetectorEvent.DoubleTap) main.post { if (running) onDoubleTap() }
    }

    fun start(): Boolean {
        val accelerometer = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return false
        val sensorThread = HandlerThread("muchtoman-tap").also { it.start() }
        val handler = Handler(sensorThread.looper)
        val registered = register(accelerometer, TAP_SAMPLING_PERIOD_US, handler) ||
            register(accelerometer, SensorManager.SENSOR_DELAY_GAME, handler)
        if (!registered) {
            sensorThread.quitSafely()
            return false
        }
        sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { register(it, GYROSCOPE_SAMPLING_PERIOD_US, handler) }
        thread = sensorThread
        running = true
        return true
    }

    fun stop() {
        running = false
        sensors.unregisterListener(this)
        thread?.quitSafely()
        thread = null
        main.removeCallbacksAndMessages(null)
    }

    /** A sensor that refuses registration costs the gesture, never the service. */
    private fun register(sensor: Sensor, periodUs: Int, handler: Handler): Boolean = try {
        sensors.registerListener(this, sensor, periodUs, handler)
    } catch (e: SecurityException) {
        logFailure("double tap sensor", e)
        false
    } catch (e: IllegalArgumentException) {
        logFailure("double tap sensor", e)
        false
    }

    override fun onSensorChanged(event: SensorEvent) {
        val v = event.values
        when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> detector.onAcceleration(event.timestamp, v[0], v[1], v[2])
            Sensor.TYPE_GYROSCOPE -> detector.onRotationRate(event.timestamp, v[0], v[1], v[2])
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}

private fun ensureDoubleTapChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(DOUBLE_TAP_CHANNEL) != null) return
    manager.createNotificationChannel(
        NotificationChannel(DOUBLE_TAP_CHANNEL, "دو ضربه پشت گوشی", NotificationManager.IMPORTANCE_MIN).apply {
            description = "تا وقتی دو ضربه روشنه، این اعلان بی‌صدا توی پایین فهرست می‌مونه."
            setShowBadge(false)
        },
    )
}

private const val DOUBLE_TAP_CHANNEL = "double_tap"

/** Clear of Notify.kt's ids (1–7), which share this app's notification id space. */
private const val DOUBLE_TAP_NOTE_ID = 40

private const val TAP_LOG = "muchtoman-tap"

/** 200 Hz: the Android 12+ ceiling for an app without HIGH_SAMPLING_RATE_SENSORS. */
private const val TAP_SAMPLING_PERIOD_US = 5_000
private const val GYROSCOPE_SAMPLING_PERIOD_US = 10_000
