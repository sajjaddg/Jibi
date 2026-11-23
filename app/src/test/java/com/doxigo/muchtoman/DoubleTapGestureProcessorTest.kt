package com.doxigo.muchtoman

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DoubleTapGestureProcessorTest {
    private val configuration = DoubleTapConfiguration(
        minimumTapIntervalMs = 90,
        maximumTapIntervalMs = 360,
        cooldownMs = 1_000,
    )

    @Test
    fun twoTapsInsideWindowTrigger() {
        val processor = DoubleTapGestureProcessor(configuration)
        assertFalse(processor.processTap(100))
        assertTrue(processor.processTap(300))
    }

    @Test
    fun tapsThatAreTooFastDoNotTrigger() {
        val processor = DoubleTapGestureProcessor(configuration)
        assertFalse(processor.processTap(100))
        assertFalse(processor.processTap(150))
    }

    @Test
    fun lateTapStartsANewPair() {
        val processor = DoubleTapGestureProcessor(configuration)
        assertFalse(processor.processTap(100))
        assertFalse(processor.processTap(600))
        assertTrue(processor.processTap(800))
    }

    @Test
    fun cooldownBlocksAnotherPair() {
        val processor = DoubleTapGestureProcessor(configuration)
        assertFalse(processor.processTap(100))
        assertTrue(processor.processTap(300))
        assertFalse(processor.processTap(500))
        assertFalse(processor.processTap(700))
    }

    @Test
    fun processorRearmsAfterCooldown() {
        val processor = DoubleTapGestureProcessor(configuration)
        assertFalse(processor.processTap(100))
        assertTrue(processor.processTap(300))
        assertFalse(processor.processTap(1_400))
        assertTrue(processor.processTap(1_600))
    }

    @Test
    fun decisionsExplainEachTap() {
        val processor = DoubleTapGestureProcessor(configuration)
        assertEquals(DoubleTapDecision.FIRST_TAP, processor.onTap(100))
        assertEquals(DoubleTapDecision.TOO_SOON, processor.onTap(150))
        assertEquals(DoubleTapDecision.TRIGGERED, processor.onTap(300))
        assertEquals(DoubleTapDecision.COOLDOWN, processor.onTap(500))
    }

    @Test
    fun cancelPendingForgetsTheFirstTap() {
        val processor = DoubleTapGestureProcessor(configuration)
        assertFalse(processor.processTap(100))
        processor.cancelPending()
        assertFalse(processor.processTap(300))
        assertTrue(processor.processTap(500))
    }
}
