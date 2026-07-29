import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AgentTier } from '~/types/domain'
import { DEFAULT_AGENT_TIER_LEVEL, isAgentTier } from '~/utils/agentTier'

/**
 * How deep into the agent catalog the two catalog surfaces reach — the pipeline builder's
 * palette and the model preset's per-agent override list.
 *
 * ONE persisted preference shared by both, not a per-surface one: the two are halves of the
 * same job (pick the agents a pipeline runs, then pick what each of them runs on), so a user
 * who widened the palette to reach a specialist kind expects to find that same kind when they
 * go to pin its model. Persisted like the interface mode's own preference, so the choice
 * survives a reload.
 *
 * Distinct from `uiMode` (the SPA-wide basic/advanced interface tier) on purpose — see
 * `utils/agentTier.ts` for why the axes stay separate.
 */
export const useAgentTierStore = defineStore(
  'agentTier',
  () => {
    /** The selected level, persisted. Seeded to the everyday-loop default. */
    const storedTier = ref<AgentTier>(DEFAULT_AGENT_TIER_LEVEL)

    // The restored value is untrusted input (a blob written by an older build, or hand-edited),
    // and a catalog filtered on an unknown level would show nothing at all — so fall back
    // rather than trust it, exactly as `uiMode` does with its persisted mode.
    const tier = computed<AgentTier>(() =>
      isAgentTier(storedTier.value) ? storedTier.value : DEFAULT_AGENT_TIER_LEVEL,
    )

    /** Whether the widest level is selected, i.e. the whole catalog is showing. */
    const showsAll = computed(() => tier.value === 'advanced')

    function setTier(next: AgentTier) {
      storedTier.value = next
    }

    return { tier, showsAll, storedTier, setTier }
  },
  { persist: { pick: ['storedTier'] } },
)
