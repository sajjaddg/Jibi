package com.doxigo.muchtoman

import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Translucent, standalone entry sheet opened by «دو ضربه پشت گوشی».
 *
 * Runs in its own empty taskAffinity without starting [MainActivity], so double-tapping over any
 * screen slides [ManualTxnSheet] up in place and drops back to that screen on save or dismiss.
 */
class QuickEntryActivity : FragmentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = Store(this)
        if (BuildConfig.LITE || !store.onboarded) {
            finishQuick()
            return
        }
        enableEdgeToEdge()
        if (store.lockEnabled) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                setRecentsScreenshotEnabled(false)
            } else {
                window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }

        setContent {
            var locked by remember { mutableStateOf(store.lockEnabled) }
            var loaded by remember { mutableStateOf(false) }
            var categories by remember { mutableStateOf<List<Category>>(emptyList()) }
            var categoryUse by remember { mutableStateOf<Map<String, Double>>(emptyMap()) }
            var notes by remember { mutableStateOf<List<NoteUse>>(emptyList()) }
            var marks by remember { mutableStateOf<Map<String, CategoryGlyph>>(emptyMap()) }
            val accounts = remember { store.bankAccounts }

            LaunchedEffect(Unit) {
                withContext(Dispatchers.Default) {
                    val durable = DurableDb.get(applicationContext)
                    val derived = DerivedDb.get(applicationContext)
                    seedBuiltins(durable)
                    val ledger = ledgerEntries(derived, durable)
                    categories = ledger.categories
                    categoryUse = categoryUseOf(ledger.entries, tehranDay(System.currentTimeMillis()))
                    notes = noteUseOf(ledger.entries)
                    marks = ledger.marks
                    loaded = true
                }
            }

            val lifecycleOwner = LocalLifecycleOwner.current
            DisposableEffect(lifecycleOwner) {
                val observer = LifecycleEventObserver { _, event ->
                    if (event == Lifecycle.Event.ON_STOP && store.lockEnabled) {
                        locked = true
                    }
                }
                lifecycleOwner.lifecycle.addObserver(observer)
                onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
            }

            LaunchedEffect(locked) {
                if (locked) {
                    WindowCompat.getInsetsController(window, window.decorView)
                        .isAppearanceLightStatusBars = false
                }
            }

            MuchTomanTheme(mode = store.themeMode, textSize = store.textSize) {
                CompositionLocalProvider(
                    LocalLayoutDirection provides LayoutDirection.Rtl,
                    LocalCustomGlyphs provides marks,
                ) {
                    when {
                        locked -> {
                            val open = {
                                promptUnlock(
                                    this@QuickEntryActivity,
                                    onNothingToCheck = {
                                        store.lockEnabled = false
                                        locked = false
                                    },
                                ) { locked = false }
                            }
                            LaunchedEffect(Unit) { open() }
                            Surface(color = MaterialTheme.colorScheme.background) {
                                LockScreen(onUnlock = open)
                            }
                        }

                        loaded -> {
                            ManualTxnSheet(
                                categories = categories,
                                categoryUse = categoryUse,
                                notes = notes,
                                accounts = accounts,
                                onSave = { rial, categoryId, merchant, note, at, accountId ->
                                    saveQuickEntry(
                                        context = applicationContext,
                                        signedRial = rial,
                                        categoryId = categoryId,
                                        merchant = merchant,
                                        note = note,
                                        at = at,
                                        accountId = accountId,
                                    )
                                    Toast.makeText(applicationContext, "ثبت شد.", Toast.LENGTH_SHORT).show()
                                    finishQuick()
                                },
                                onDismiss = ::finishQuick,
                            )
                        }
                    }
                }
            }
        }
    }

    private fun finishQuick() {
        finish()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        } else {
            @Suppress("DEPRECATION")
            overridePendingTransition(0, 0)
        }
    }
}

/** Application-lived so saving and syncing still finish after [QuickEntryActivity.finish]. */
private val QUICK_ENTRY_SCOPE = CoroutineScope(SupervisorJob() + Dispatchers.Default)

private fun saveQuickEntry(
    context: Context,
    signedRial: Long,
    categoryId: String?,
    merchant: String,
    note: String,
    at: Long,
    accountId: String?,
) {
    val app = context.applicationContext
    QUICK_ENTRY_SCOPE.launch {
        val store = Store(app)
        val durable = DurableDb.get(app)
        val derived = DerivedDb.get(app)
        val extra = extraLookup(store.extraBankNumbers)
        runCatching {
            persistManualTxn(
                durable = durable,
                derived = derived,
                extraBanks = extra,
                signedRial = signedRial,
                categoryId = categoryId,
                merchant = merchant,
                note = note,
                at = at,
                accountId = accountId,
            )
            if (accountId != null && settleTypedAccounts(store, durable, derived) != null) {
                updateTotalWidget(app)
            }
            ledgerLanded.tryEmit(Unit)
            loadSession(durable)?.let { session ->
                val result = syncNow(durable, derived, session)
                if (result.received > 0 || needsDerive(derived, durable)) {
                    derive(durable, derived, extra)
                    ledgerLanded.tryEmit(Unit)
                }
            }
        }.onFailure { logFailure("quick entry save failed", it) }
    }
}
