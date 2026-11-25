package com.doxigo.muchtoman

import android.content.Context
import android.content.Intent
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Verifies the double-tap quick-entry boundary: launching the gesture targets [QuickEntryActivity]
 * rather than [MainActivity], and [persistManualTxn] writes and derives the row directly without
 * needing [AppVm].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class QuickEntryTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var durable: DurableDb
    private lateinit var derived: DerivedDb

    @Before
    fun openDbs() {
        durable = Room.inMemoryDatabaseBuilder(context, DurableDb::class.java)
            .allowMainThreadQueries()
            .build()
        derived = Room.inMemoryDatabaseBuilder(context, DerivedDb::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun closeDbs() {
        derived.close()
        durable.close()
    }

    @Test
    fun `double tap targets QuickEntryActivity instead of MainActivity`() {
        val intent = quickEntryIntent(context)
        assertEquals(QuickEntryActivity::class.java.name, intent.component?.className)
        assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
    }

    @Test
    fun `persistManualTxn stores row, category and note then derives into ledger`() = runBlocking {
        seedBuiltins(durable)
        val at = 1_800_000_000_000L
        persistManualTxn(
            durable = durable,
            derived = derived,
            extraBanks = emptyMap(),
            signedRial = -2_500_000L,
            categoryId = "cat_dining",
            merchant = "نانوایی",
            note = "نان سنگک",
            at = at,
            accountId = null,
            now = at,
        )

        val ledger = ledgerEntries(derived, durable)
        assertEquals(1, ledger.entries.size)
        val row = ledger.entries.single()
        assertEquals(-2_500_000L, row.txn.signedRial)
        assertEquals("نانوایی", row.txn.merchant)
        assertEquals("cat_dining", row.categoryId)
        assertEquals("نان سنگک", row.note)
        assertNotNull(durable.manual().all().singleOrNull())
    }
}
