import { describe, it, expect } from 'vitest'
import { createUiModals } from '~/stores/ui/modals'

/**
 * The model configuration opened from the pipeline builder replaces the builder and returns to it
 * on close. The builder is a modal Reka slideover, which makes everything outside it unclickable,
 * so the model configuration (the app's own takeover) can never be open over it.
 */
describe('pipeline builder to model configuration handoff', () => {
  it('closes the builder while the model configuration is open, and reopens it on close', () => {
    const ui = createUiModals()
    ui.openBuilder()

    ui.openModelConfig()
    expect(ui.builderOpen.value).toBe(false)
    expect(ui.modelConfigOpen.value).toBe(true)

    ui.closeModelConfig()
    expect(ui.modelConfigOpen.value).toBe(false)
    expect(ui.builderOpen.value).toBe(true)
  })

  it('does not open the builder when the model configuration was opened without it', () => {
    const ui = createUiModals()
    ui.openModelConfig()
    ui.closeModelConfig()
    expect(ui.builderOpen.value).toBe(false)
  })

  it('returns to the builder once, not on every later close', () => {
    const ui = createUiModals()
    ui.openBuilder()
    ui.openModelConfig()
    ui.closeModelConfig()
    ui.builderOpen.value = false

    ui.openModelConfig()
    ui.closeModelConfig()
    expect(ui.builderOpen.value).toBe(false)
  })
})
