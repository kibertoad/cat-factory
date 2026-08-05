import { describe, expect, it } from 'vitest'
import { resolvePanels } from '@modular-vue/core'
import type { PanelEntry } from '@modular-vue/core'
import type { Block, BlockLevel, BlockType } from '~/types/domain'
import { INSPECTOR_PANEL_IDS, INSPECTOR_PANEL_SPECS } from './inspector.logic'

/**
 * Pins the inspector panel group's gating + ordering (slice 4 of the modular-vue
 * adoption) against the pre-slice-4 `InspectorPanel.vue` `v-if` fan, using the
 * SAME pure `resolvePanels` the host resolves through. A stub component per spec
 * stands in for the real SFC (the gating/order is component-agnostic).
 */

const ENTRIES: PanelEntry<Block>[] = INSPECTOR_PANEL_SPECS.map((spec) => ({
  id: spec.id,
  order: spec.order,
  when: spec.when,
  // A trivial functional component stands in for the real SFC — the gating/order
  // under test is component-agnostic; `() => null` satisfies the engine's
  // `UiComponent` (a callable) without pulling a Vue runtime into the unit test.
  component: () => null,
}))

const block = (level: BlockLevel, type: BlockType = 'service'): Block =>
  ({ id: `b-${level}-${type}`, level, type }) as unknown as Block

const visibleIds = (b: Block | null) => resolvePanels(ENTRIES, b).map((e) => e.id)

describe('inspector panel group', () => {
  it('every id has exactly one spec (no dup, no gap)', () => {
    const specIds = INSPECTOR_PANEL_SPECS.map((s) => s.id).sort()
    expect(specIds).toEqual([...INSPECTOR_PANEL_IDS].sort())
    expect(new Set(specIds).size).toBe(specIds.length)
  })

  it('a service frame shows the container + service panels, ordered, no frontend-config', () => {
    expect(visibleIds(block('frame', 'service'))).toEqual([
      'container-summary',
      'service-connections',
      'service-test-config',
      'service-test-secrets',
      'service-fragments',
      'service-release-health',
      'service-validation-checks',
    ])
  })

  it('a document frame hides the test-infra / test-credentials / release-health panels', () => {
    // A doc repo stands up no test env and ships no release, so those panels don't apply.
    expect(visibleIds(block('frame', 'document'))).toEqual([
      'container-summary',
      'service-fragments',
    ])
  })

  it('a library frame still shows the test/deploy panels (only document is excluded)', () => {
    expect(visibleIds(block('frame', 'library'))).toEqual([
      'container-summary',
      'service-test-config',
      'service-test-secrets',
      'service-fragments',
      'service-release-health',
      'service-validation-checks',
    ])
  })

  it('a frontend frame swaps connections for frontend-config', () => {
    expect(visibleIds(block('frame', 'frontend'))).toEqual([
      'container-summary',
      'frontend-config',
      'service-test-config',
      'service-test-secrets',
      'service-fragments',
      'service-release-health',
      'service-validation-checks',
    ])
  })

  it('a module shows only the container summary', () => {
    expect(visibleIds(block('module'))).toEqual(['container-summary'])
  })

  // The reviewed PR is the review task's SUBJECT, so it leads the body — above the context the
  // task was given and the run that acts on it. Every other task type never sees the panel.
  it('a review task leads with its review target', () => {
    const review = { ...block('task'), taskType: 'review' } as Block
    expect(visibleIds(review)[0]).toBe('task-review-target')
  })

  it('a task shows the task body in the pre-slice-4 order', () => {
    expect(visibleIds(block('task'))).toEqual([
      'task-context-docs',
      'task-context-issues',
      'recurring-schedule',
      'task-execution',
      'task-estimate',
      'task-dependencies',
      'task-run-settings',
      'task-agent-config',
      // The custom type's own declared fields sit with the other task INPUTS (what the task is),
      // not under run settings (how it runs). It is gated on being a task alone: the panel hides
      // itself unless the type is one this deployment registered with descriptor fields, which
      // the spec here cannot see and should not try to.
      'task-type-fields',
      'task-structure',
    ])
  })

  it('an epic shows only its children panel', () => {
    expect(visibleIds(block('epic'))).toEqual(['epic-children'])
  })

  // An initiative shares two of the task body's panels: the CONTEXT sections (the
  // create-initiative modal attaches the same documents/issues, and the planning pipeline reads
  // them, so the inspector must surface them) and the execution panel (planning is an ordinary
  // run — and that panel carries the only Stop / Discard-run controls that unwedge a stalled
  // one). Order is pinned too: identity + controls, the context it was given, then the run.
  it('an initiative shows its inspector, then the shared context + execution panels', () => {
    expect(visibleIds(block('initiative'))).toEqual([
      'initiative-inspector',
      'task-context-docs',
      'task-context-issues',
      'task-execution',
    ])
  })

  it('no subject selected resolves to no panels', () => {
    expect(visibleIds(null)).toEqual([])
  })

  // Locks the contract the client plugin's boot fail-fast depends on: it calls
  // `resolvePanels(mergedEntries, null)` once at startup so a duplicate panel id
  // (e.g. a consumer module colliding with a first-party id) throws at BOOT rather
  // than the first time a block is selected. That only works because `resolvePanels`
  // runs its duplicate-id check BEFORE the null-subject short-circuit — pin it here
  // so an upstream reorder (dedup after the null guard) can't silently disarm the
  // boot check.
  it('throws on a duplicate panel id even with a null subject (boot fail-fast)', () => {
    const dup: PanelEntry<Block>[] = [
      { id: 'container-summary', order: 1, when: () => true, component: () => null },
      { id: 'container-summary', order: 2, when: () => true, component: () => null },
    ]
    expect(() => resolvePanels(dup, null)).toThrow(/duplicate panel id "container-summary"/)
  })
})
