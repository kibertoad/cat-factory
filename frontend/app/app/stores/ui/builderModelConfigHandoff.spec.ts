import { describe, it, expect } from 'vitest'
import { createUiModals } from '~/stores/ui/modals'

/**
 * The pipeline builder and the model configuration never stack. The builder is a modal Reka
 * slideover that holds `pointer-events: none` on <body> until its exit animation ends, so the
 * model configuration (the app's own takeover) only shows once the builder reports it has left.
 */
describe('pipeline builder to model configuration handoff', () => {
  it('shows the model configuration only after the builder has left, and reopens the builder on close', () => {
    const ui = createUiModals()
    ui.openBuilder()

    ui.openModelConfig()
    expect(ui.builderOpen.value).toBe(false)
    expect(ui.modelConfigOpen.value).toBe(false)

    ui.builderLeft()
    expect(ui.modelConfigOpen.value).toBe(true)

    ui.closeModelConfig()
    expect(ui.modelConfigOpen.value).toBe(false)
    expect(ui.builderOpen.value).toBe(true)
  })

  it('opens at once when the builder is not open, and ignores a stray builder exit', () => {
    const ui = createUiModals()
    ui.openModelConfig()
    expect(ui.modelConfigOpen.value).toBe(true)

    ui.closeModelConfig()
    expect(ui.builderOpen.value).toBe(false)

    ui.builderLeft()
    expect(ui.modelConfigOpen.value).toBe(false)
  })

  it('returns to the builder once, not on every later close', () => {
    const ui = createUiModals()
    ui.openBuilder()
    ui.openModelConfig()
    ui.builderLeft()
    ui.closeModelConfig()
    ui.builderOpen.value = false

    ui.openModelConfig()
    ui.closeModelConfig()
    expect(ui.builderOpen.value).toBe(false)
  })

  it('opening the builder another way closes the model configuration and drops the return', () => {
    const ui = createUiModals()
    ui.openBuilder()
    ui.openModelConfig()
    ui.builderLeft()

    ui.openBuilder()
    expect(ui.modelConfigOpen.value).toBe(false)
    expect(ui.builderOpen.value).toBe(true)

    ui.builderOpen.value = false
    ui.openModelConfig()
    ui.closeModelConfig()
    expect(ui.builderOpen.value).toBe(false)
  })

  it('drops a pending show when the builder is reopened before it has left', () => {
    const ui = createUiModals()
    ui.openBuilder()
    ui.openModelConfig()
    ui.openBuilder()

    ui.builderLeft()
    expect(ui.modelConfigOpen.value).toBe(false)
  })

  it('reports a return to the builder once, so it can skip its reloads', () => {
    const ui = createUiModals()
    ui.openBuilder()
    expect(ui.consumeBuilderReturn()).toBe(false)

    ui.openModelConfig()
    ui.builderLeft()
    ui.closeModelConfig()
    expect(ui.consumeBuilderReturn()).toBe(true)
    expect(ui.consumeBuilderReturn()).toBe(false)
  })
})
