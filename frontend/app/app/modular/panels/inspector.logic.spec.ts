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
    ])
  })

  it('a module shows only the container summary', () => {
    expect(visibleIds(block('module'))).toEqual(['container-summary'])
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
      'task-structure',
    ])
  })

  it('epic and initiative each show their single inspector', () => {
    expect(visibleIds(block('epic'))).toEqual(['epic-children'])
    expect(visibleIds(block('initiative'))).toEqual(['initiative-inspector'])
  })

  it('no subject selected resolves to no panels', () => {
    expect(visibleIds(null)).toEqual([])
  })
})
