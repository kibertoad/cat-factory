import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { RemoteModuleManifest } from '@modular-vue/core'
import { customTaskTypeToMeta } from '~/modular/task-types'
import type { AppSlots } from '~/modular/slots'
import { TASK_TYPE_META, setCustomTaskTypeMeta } from '~/utils/catalog'
import type { CustomTaskType, TaskTypeMeta } from '~/types/domain'

/**
 * The custom task-type catalog (frontend-extension-mechanism initiative, slice B) — the exact twin
 * of the agents store (`stores/agents.ts`), which is the template for every capability catalog.
 *
 * Reactive union of two sources, neither mutating the built-in {@link TASK_TYPE_META} const:
 *  - CONSUMER-shipped task types contributed as CODE via the modular `taskTypes` slot
 *    (`registerConsumerTaskTypes`, fed once at boot from the resolved manifest);
 *  - the deployment's BACKEND-registered task types, folded into the single per-workspace
 *    {@link RemoteModuleManifest} the workspace store swaps per snapshot (`hydrateCapabilities`,
 *    reading its OWN `taskTypes` slot off the shared manifest).
 *
 * The merged custom catalog is projected back into `catalog.ts`'s {@link setCustomTaskTypeMeta}
 * read-model so the pure `taskTypeMeta` lookup (used by the card badge + create-task picker)
 * resolves a custom type reactively without importing this store.
 */
export const useTaskTypesStore = defineStore('taskTypes', () => {
  // CODE-shipped consumer task types from the static `taskTypes` slot (fed once at boot by the
  // modular install plugin — module slots are resolved once).
  const consumerTaskTypes = ref<CustomTaskType[]>([])
  // The active per-workspace capability manifest (shared with the agents store), or null before
  // the first hydrate. This store reads only its own `taskTypes` slot off it.
  const capabilitiesManifest = ref<RemoteModuleManifest<AppSlots> | null>(null)

  /**
   * The merged CUSTOM task types (consumer-slot → backend-manifest), de-duplicated and never
   * shadowing a BUILT-IN type. A namespaced custom id can't collide with a bare built-in, but the
   * built-in drop is kept for parity with the agents store (and to be robust to a malformed id).
   */
  const customTaskTypes = computed<CustomTaskType[]>(() => {
    const seen = new Set<string>()
    const out: CustomTaskType[] = []
    const add = (t: CustomTaskType) => {
      if (t.taskType in TASK_TYPE_META || seen.has(t.taskType)) return
      seen.add(t.taskType)
      out.push(t)
    }
    for (const t of consumerTaskTypes.value) add(t)
    for (const t of capabilitiesManifest.value?.slots?.taskTypes ?? []) add(t)
    return out
  })

  /** The custom types indexed by id, for a per-type lookup (e.g. the create-form field descriptors). */
  const byTaskType = computed<Record<string, CustomTaskType>>(() =>
    Object.fromEntries(customTaskTypes.value.map((t) => [t.taskType, t])),
  )

  // Keep `catalog.ts`'s pure-util projection in sync with the merged custom catalog so
  // `taskTypeMeta` resolves custom types. Sync flush so an imperative read right after
  // `hydrateCapabilities` sees the fresh catalog with no tick gap (mirrors the agents store).
  const customMetaMap = computed<Record<string, TaskTypeMeta>>(() =>
    Object.fromEntries(customTaskTypes.value.map((t) => [t.taskType, customTaskTypeToMeta(t)])),
  )
  watch(customMetaMap, (map) => setCustomTaskTypeMeta(map), { immediate: true, flush: 'sync' })

  /** The registered custom task type for `taskType`, or undefined. */
  function get(taskType: string): CustomTaskType | undefined {
    return byTaskType.value[taskType]
  }

  /**
   * Register the deployment's CODE-shipped consumer task types — the resolved modular `taskTypes`
   * slot, fed once by the install plugin. Idempotent replace (module slots resolve once).
   */
  function registerConsumerTaskTypes(types: readonly CustomTaskType[]) {
    consumerTaskTypes.value = [...types]
  }

  /**
   * Hydrate the deployment's BACKEND-registered capabilities from the shared per-workspace manifest
   * (built by the workspace store from the snapshot, carrying both `agentKinds` + `taskTypes`).
   * Skips the swap — and the downstream projection invalidation — when the content-derived manifest
   * version is unchanged, exactly like the agents store.
   */
  function hydrateCapabilities(manifest: RemoteModuleManifest<AppSlots>) {
    if (capabilitiesManifest.value?.version === manifest.version) return
    capabilitiesManifest.value = manifest
  }

  return { customTaskTypes, get, registerConsumerTaskTypes, hydrateCapabilities }
})
