<script setup lang="ts">
// The agent-tier control, shared by the pipeline builder's palette and the model preset's
// per-agent override list (the two surfaces that enumerate the agent catalog).
//
// Tiers are CUMULATIVE, so this is a level dial rather than a set of independent toggles:
// `basic` is the everyday delivery loop, `intermediate` adds the kinds reached for regularly,
// and `advanced` — the widest level — shows the whole catalog. The trailing hint states how
// many kinds the current level is holding back, so a narrowed catalog never reads as the
// complete one.
import { computed } from 'vue'
import { AGENT_TIERS, type AgentTier } from '@cat-factory/contracts'

const { t } = useI18n()
const agentTier = useAgentTierStore()

const props = defineProps<{
  /** How many kinds the current level hides. Renders the "n hidden" hint when > 0. */
  hiddenCount?: number
}>()

// One STATIC literal `t()` key per tier (not a key assembled from the loop variable), so the
// typed-message-keys check covers them — the same shape the vendor/enum-keyed sets use.
const TIER_LABELS = computed<Record<AgentTier, string>>(() => ({
  basic: t('agentTier.basic'),
  intermediate: t('agentTier.intermediate'),
  advanced: t('agentTier.advanced'),
}))
const TIER_HINTS = computed<Record<AgentTier, string>>(() => ({
  basic: t('agentTier.basicHint'),
  intermediate: t('agentTier.intermediateHint'),
  advanced: t('agentTier.advancedHint'),
}))

const items = computed(() => [
  AGENT_TIERS.map((tier) => ({
    label: TIER_LABELS.value[tier],
    // The hint is what distinguishes "everything below this level" from "only this level",
    // which the bare tier names cannot say.
    description: TIER_HINTS.value[tier],
    icon: tier === agentTier.tier ? 'i-lucide-check' : 'i-lucide-layers',
    onSelect: () => agentTier.setTier(tier),
  })),
])
</script>

<template>
  <div class="space-y-1">
    <UDropdownMenu :items="items" :ui="{ content: 'z-[60] max-w-72' }">
      <UButton
        size="xs"
        color="neutral"
        variant="soft"
        icon="i-lucide-layers"
        trailing-icon="i-lucide-chevron-down"
        class="w-full justify-between"
        :title="t('agentTier.tooltip')"
      >
        <span class="truncate">
          {{ t('agentTier.label') }}: {{ TIER_LABELS[agentTier.tier] }}
        </span>
      </UButton>
    </UDropdownMenu>
    <p v-if="props.hiddenCount" class="px-1 text-[10px] text-slate-500">
      {{ t('agentTier.hidden', { count: props.hiddenCount }, props.hiddenCount) }}
    </p>
  </div>
</template>
