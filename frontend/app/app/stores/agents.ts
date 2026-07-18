import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { RemoteModuleManifest } from '@modular-vue/core'
import { buildAgentCapabilitiesManifest, customKindToArchetype } from '~/modular/agent-kinds'
import type { AppSlots } from '~/modular/slots'
import {
  AGENT_ARCHETYPES,
  AGENT_BY_KIND,
  setCustomAgentKindMeta,
  SYSTEM_AGENT_META,
  uid,
} from '~/utils/catalog'
import type { AgentArchetype, AgentKind, CustomAgentKind } from '~/types/domain'

/**
 * The agent palette catalog (slice 2 of the modular-vue adoption —
 * docs/initiatives/modular-vue-adoption.md).
 *
 * Reactive union of three sources, none of which mutates the frozen built-in
 * {@link AGENT_BY_KIND} const any more:
 *  - the built-in archetypes (static);
 *  - CONSUMER-shipped kinds contributed as CODE via the modular `agentKinds`
 *    slot (`registerConsumerKinds`, fed once at boot from the resolved manifest);
 *  - the deployment's BACKEND-registered kinds, modeled as a single
 *    {@link RemoteModuleManifest} swapped per workspace snapshot
 *    (`hydrateCustomKinds`) and read directly (single-active-manifest shape).
 *
 * The merged custom catalog is projected back into `catalog.ts`'s
 * {@link setCustomAgentKindMeta} read-model so the pure `agentKindMeta` /
 * `isKnownAgentKind` lookups (used across ~17 renderers) resolve a custom kind
 * reactively without importing this store.
 */
export const useAgentsStore = defineStore('agents', () => {
  // CODE-shipped consumer kinds from the static `agentKinds` slot (fed once at
  // boot by the modular install plugin — module slots are resolved once).
  const consumerKinds = ref<CustomAgentKind[]>([])
  // The active per-workspace capability manifest built from the snapshot's
  // `customAgentKinds`, or null before the first hydrate.
  const capabilitiesManifest = ref<RemoteModuleManifest<AppSlots> | null>(null)
  // In-UI, client-only prototype agents created via the "add agent" modal.
  const runtimeAgents = ref<AgentArchetype[]>([])

  /**
   * The merged CUSTOM catalog (consumer-slot → backend-manifest → runtime), each
   * mapped to display metadata, de-duplicated, and never shadowing a built-in or
   * system kind (a custom kind can't override a built-in — the old skip guard).
   */
  const customArchetypes = computed<AgentArchetype[]>(() => {
    const seen = new Set<string>()
    const out: AgentArchetype[] = []
    const add = (a: AgentArchetype) => {
      if (a.kind in AGENT_BY_KIND || a.kind in SYSTEM_AGENT_META || seen.has(a.kind)) return
      seen.add(a.kind)
      out.push(a)
    }
    for (const k of consumerKinds.value) add(customKindToArchetype(k))
    for (const k of capabilitiesManifest.value?.slots?.agentKinds ?? [])
      add(customKindToArchetype(k))
    for (const a of runtimeAgents.value) add(a)
    return out
  })

  /** The full palette: built-in archetypes + the merged custom ones. */
  const archetypes = computed<AgentArchetype[]>(() => [
    ...AGENT_ARCHETYPES,
    ...customArchetypes.value,
  ])

  // Known-kind lookup (built-in ∪ system ∪ custom) for `get`.
  const customByKind = computed<Record<string, AgentArchetype>>(() =>
    Object.fromEntries(customArchetypes.value.map((a) => [a.kind, a])),
  )

  // Keep `catalog.ts`'s pure-util projection in sync with the merged custom
  // catalog so `agentKindMeta` / `isKnownAgentKind` resolve custom kinds. Sync
  // flush so an imperative read right after `hydrateCustomKinds` (e.g. the run
  // dispatch resolving a custom kind's `resultView`) sees the fresh catalog with
  // no tick gap. The watch lives in the store's effect scope (disposed with it).
  watch(customByKind, (map) => setCustomAgentKindMeta(map), { immediate: true, flush: 'sync' })

  /** Display metadata for a KNOWN kind (built-in / system / custom), else undefined. */
  function get(kind: AgentKind): AgentArchetype | undefined {
    return AGENT_BY_KIND[kind] ?? SYSTEM_AGENT_META[kind] ?? customByKind.value[kind]
  }

  /**
   * Add an in-UI prototype agent (the pipeline builder's "add agent" modal).
   * Client-only, so it lives in store state — no backend, no global mutation.
   */
  function addAgent(input: {
    label: string
    description?: string
    icon?: string
    color?: string
  }): AgentArchetype {
    const archetype: AgentArchetype = {
      // custom kinds are free-form ids; cast keeps the existing AgentKind typing happy
      kind: uid('agent') as AgentKind,
      label: input.label.trim() || 'Custom Agent',
      description: input.description?.trim() || 'Custom agent.',
      icon: input.icon || 'i-lucide-sparkles',
      color: input.color || '#22d3ee',
    }
    runtimeAgents.value = [...runtimeAgents.value, archetype]
    return archetype
  }

  /**
   * Register the deployment's CODE-shipped consumer agent kinds — the resolved
   * modular `agentKinds` slot, fed once by the install plugin. Idempotent
   * replace (module slots resolve once, so this is called a single time).
   */
  function registerConsumerKinds(kinds: readonly CustomAgentKind[]) {
    consumerKinds.value = [...kinds]
  }

  /**
   * Hydrate the deployment's BACKEND-registered custom kinds from a workspace
   * snapshot, modeled as a single remote capability manifest (swapped wholesale
   * per workspace). Replaces the old `registerCustomKinds` that mutated
   * {@link AGENT_BY_KIND} directly.
   */
  function hydrateCustomKinds(kinds: CustomAgentKind[]) {
    capabilitiesManifest.value = buildAgentCapabilitiesManifest(kinds)
  }

  return {
    archetypes,
    customArchetypes,
    get,
    addAgent,
    registerConsumerKinds,
    hydrateCustomKinds,
  }
})
