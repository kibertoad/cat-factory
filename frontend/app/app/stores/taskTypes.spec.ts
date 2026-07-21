import { describe, expect, it } from 'vitest'
import { useTaskTypesStore } from './taskTypes'
import { buildWorkspaceCapabilitiesManifest } from '~/modular/capabilities'
import { __resetCustomTaskTypeMetaForTest, isKnownTaskType, taskTypeMeta } from '~/utils/catalog'
import type { CustomTaskType } from '~/types/domain'

const backendType = (
  taskType: string,
  over: Partial<CustomTaskType['presentation']> = {},
): CustomTaskType => ({
  taskType,
  presentation: {
    label: `L:${taskType}`,
    icon: 'i-lucide-siren',
    color: '#ef4444',
    description: 'd',
    ...over,
  },
})

/** Hydrate the store's backend-manifest half with `taskTypes` (via the shared capability manifest). */
const hydrate = (
  store: ReturnType<typeof useTaskTypesStore>,
  taskTypes: CustomTaskType[],
): void => {
  store.hydrateCapabilities(buildWorkspaceCapabilitiesManifest([], taskTypes))
}

describe('taskTypes store — custom task-type catalog (extension slice B)', () => {
  it('exposes no custom types before any hydrate', () => {
    const store = useTaskTypesStore()
    expect(store.customTaskTypes).toEqual([])
  })

  it('folds a backend remote-manifest custom type into the catalog + the pure-util projection', () => {
    __resetCustomTaskTypeMetaForTest()
    const store = useTaskTypesStore()
    // Before hydrate the pure-util lookups don't know the type; taskTypeMeta degrades to `feature`.
    expect(isKnownTaskType('acme:incident')).toBe(false)
    const before = taskTypeMeta('acme:incident')
    expect(before.icon).toBe(taskTypeMeta('feature').icon) // feature fallback icon
    expect(before.label).toBe('acme:incident') // raw id, never blank

    hydrate(store, [backendType('acme:incident', { label: 'Incident' })])

    // Catalog + lookup both see it now (sync-flush projection — no tick needed).
    expect(store.customTaskTypes.some((t) => t.taskType === 'acme:incident')).toBe(true)
    expect(isKnownTaskType('acme:incident')).toBe(true)
    const meta = taskTypeMeta('acme:incident')
    expect(meta.label).toBe('Incident')
    expect(meta.labelKey).toBeUndefined() // custom types carry a literal label, not an i18n key
  })

  it('never lets a custom type shadow a built-in type', () => {
    const store = useTaskTypesStore()
    hydrate(store, [backendType('feature', { label: 'Evil Feature' })])
    expect(store.customTaskTypes.some((t) => t.taskType === 'feature')).toBe(false)
    expect(taskTypeMeta('feature').labelKey).toBe('board.addTask.types.feature')
  })

  it('merges CODE-shipped consumer types with BACKEND manifest types, de-duplicated', () => {
    const store = useTaskTypesStore()
    store.registerConsumerTaskTypes([backendType('acme:consumer')])
    hydrate(store, [backendType('acme:backend'), backendType('acme:consumer')])
    const ids = store.customTaskTypes.map((t) => t.taskType)
    expect(ids).toContain('acme:consumer')
    expect(ids).toContain('acme:backend')
    expect(ids.filter((k) => k === 'acme:consumer')).toHaveLength(1)
  })

  it('no-ops a re-hydrate of identical content (content-versioned manifest)', () => {
    const store = useTaskTypesStore()
    hydrate(store, [backendType('acme:x')])
    const first = store.customTaskTypes
    hydrate(store, [backendType('acme:x')])
    expect(store.customTaskTypes).toBe(first)
  })

  it('swaps the backend catalog wholesale on re-hydrate (per-workspace manifest)', () => {
    const store = useTaskTypesStore()
    hydrate(store, [backendType('acme:ws1')])
    expect(store.customTaskTypes.some((t) => t.taskType === 'acme:ws1')).toBe(true)
    hydrate(store, [backendType('acme:ws2')])
    expect(store.customTaskTypes.some((t) => t.taskType === 'acme:ws1')).toBe(false)
    expect(store.customTaskTypes.some((t) => t.taskType === 'acme:ws2')).toBe(true)
    expect(isKnownTaskType('acme:ws1')).toBe(false)
  })

  it('get() returns the full registration (for the create-form field descriptors)', () => {
    const store = useTaskTypesStore()
    hydrate(store, [
      {
        ...backendType('acme:incident'),
        fields: [{ key: 'sev', label: 'Severity', type: 'text' }],
      },
    ])
    expect(store.get('acme:incident')?.fields?.[0]?.key).toBe('sev')
    expect(store.get('acme:unknown')).toBeUndefined()
  })
})
