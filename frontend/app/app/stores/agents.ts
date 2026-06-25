import { defineStore } from 'pinia'
import { ref } from 'vue'
import { AGENT_ARCHETYPES, AGENT_BY_KIND, uid } from '~/utils/catalog'
import type { AgentArchetype, AgentKind, CustomAgentKind } from '~/types/domain'

/**
 * The agent palette. Seeded from the static catalog, but custom agents can be
 * added at runtime (they show up in the pipeline builder). Newly created agents
 * are also registered into AGENT_BY_KIND so the many components that look an
 * agent up by kind keep rendering it correctly.
 */
export const useAgentsStore = defineStore('agents', () => {
  const archetypes = ref<AgentArchetype[]>([...AGENT_ARCHETYPES])

  function get(kind: AgentKind) {
    return AGENT_BY_KIND[kind]
  }

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
    // register for kind-based lookups across the app, then surface in the palette
    AGENT_BY_KIND[archetype.kind] = archetype
    archetypes.value.push(archetype)
    return archetype
  }

  /**
   * Merge the deployment's registered CUSTOM agent kinds (from the workspace snapshot)
   * into the palette catalog: each becomes a first-class palette block + a kind-based
   * lookup (so timelines / inspectors render it instead of the generic fallback), and its
   * declared `resultView` opens through the same registry the built-ins use. Idempotent
   * and built-in-safe — a kind already known (a built-in, or a prior load) is left
   * untouched, so a snapshot can't shadow a built-in or duplicate on reload.
   */
  function registerCustomKinds(kinds: CustomAgentKind[]) {
    for (const { kind, presentation } of kinds) {
      if (AGENT_BY_KIND[kind]) continue
      const archetype: AgentArchetype = {
        kind,
        label: presentation.label,
        icon: presentation.icon,
        color: presentation.color,
        description: presentation.description,
        ...(presentation.category ? { category: presentation.category } : {}),
        ...(presentation.resultView ? { resultView: presentation.resultView } : {}),
      }
      AGENT_BY_KIND[kind] = archetype
      archetypes.value.push(archetype)
    }
  }

  return { archetypes, get, addAgent, registerCustomKinds }
})
