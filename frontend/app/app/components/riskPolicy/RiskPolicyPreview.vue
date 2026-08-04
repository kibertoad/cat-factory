<script setup lang="ts">
// A compact, read-only summary of a risk policy: the three auto-merge ceilings grouped
// together, plus prose saying what clearing them actually DOES (the pull request merges
// without waiting for a human review). Shared by the risk-policy picker's hover preview so
// "what this policy means" is explained the same way everywhere — the <PipelinePreview>
// counterpart for merge policy.
//
// A policy with auto-merge off has no thresholds to explain (the master switch wins before
// any score is compared), so it says so instead of listing ceilings that never apply.
import { computed } from 'vue'
import type { RiskPolicy, WorkspaceRole } from '~/types/merge'
import { riskPolicyCeilings, rolePolicySummary, type RiskPolicyAxis } from '~/utils/riskPolicy'

const props = defineProps<{ policy: RiskPolicy }>()
const { t, n } = useI18n()

// The role layer, when the policy has one. Worth a line here rather than only in settings: this
// preview is what a task's merge-policy picker shows, and "runs started by a member never merge"
// changes what picking this policy means for whoever is reading it.
const ROLE_LABEL: Record<WorkspaceRole, () => string> = {
  admin: () => t('merge.role.admin'),
  member: () => t('merge.role.member'),
  viewer: () => t('merge.role.viewer'),
}
const roleLayer = computed(() => {
  const { sandboxed, narrowed } = rolePolicySummary(props.policy)
  return {
    sandboxed: sandboxed.map((r) => ROLE_LABEL[r]()).join(', '),
    narrowed: narrowed.map((r) => ROLE_LABEL[r]()).join(', '),
    any: sandboxed.length > 0 || narrowed.length > 0,
  }
})

// Exhaustive over the axis union with LITERAL keys, so both i18n drift guards apply: the
// typed-key check catches a renamed key, and the Record catches a new axis.
const AXIS_LABEL: Record<RiskPolicyAxis, () => string> = {
  risk: () => t('riskPolicy.preview.axis.risk'),
  impact: () => t('riskPolicy.preview.axis.impact'),
  complexity: () => t('riskPolicy.preview.axis.complexity'),
}

const ceilings = computed(() =>
  riskPolicyCeilings(props.policy).map((c) => ({ ...c, label: AXIS_LABEL[c.axis]() })),
)
</script>

<template>
  <div class="space-y-3" data-testid="risk-policy-preview">
    <div class="flex items-center gap-1.5">
      <span class="text-sm font-semibold text-slate-100">{{ policy.name }}</span>
      <UBadge v-if="policy.isDefault" size="sm" variant="soft" color="neutral">
        {{ t('riskPolicy.preview.defaultBadge') }}
      </UBadge>
    </div>

    <!-- the three ceilings, grouped under one heading that names what they are -->
    <div v-if="policy.autoMergeEnabled">
      <div class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
        <UIcon name="i-lucide-git-merge" class="h-3 w-3" />
        {{ t('riskPolicy.preview.autoMergeHeading') }}
      </div>
      <dl class="space-y-1">
        <div
          v-for="c in ceilings"
          :key="c.axis"
          class="flex items-baseline justify-between gap-3 rounded bg-slate-800/70 px-1.5 py-0.5 text-[12px]"
        >
          <dt class="text-slate-300">{{ c.label }}</dt>
          <dd class="tabular-nums text-slate-100">
            {{ t('riskPolicy.preview.ceiling', { value: n(c.max, { key: 'percent' }) }) }}
          </dd>
        </div>
      </dl>
      <p class="mt-1.5 text-[12px] leading-snug text-slate-400">
        {{ t('riskPolicy.preview.autoMergeExplainer') }}
      </p>
    </div>
    <div v-else>
      <div class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
        <UIcon name="i-lucide-user-check" class="h-3 w-3" />
        {{ t('riskPolicy.preview.manualHeading') }}
      </div>
      <p class="text-[12px] leading-snug text-slate-400">
        {{ t('riskPolicy.preview.manualExplainer') }}
      </p>
    </div>

    <!-- Who started the run changes what may land, on a policy that says so. -->
    <div v-if="roleLayer.any" data-testid="risk-policy-preview-roles">
      <div class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
        <UIcon name="i-lucide-users" class="h-3 w-3" />
        {{ t('riskPolicy.preview.roleHeading') }}
      </div>
      <p v-if="roleLayer.sandboxed" class="text-[12px] leading-snug text-slate-400">
        {{ t('riskPolicy.preview.roleSandboxed', { roles: roleLayer.sandboxed }) }}
      </p>
      <p v-if="roleLayer.narrowed" class="text-[12px] leading-snug text-slate-400">
        {{ t('riskPolicy.preview.roleNarrowed', { roles: roleLayer.narrowed }) }}
      </p>
    </div>

    <div>
      <div class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
        <UIcon name="i-lucide-wrench" class="h-3 w-3" />
        {{ t('riskPolicy.preview.ciHeading') }}
      </div>
      <p class="text-[12px] leading-snug text-slate-400">
        {{
          t('riskPolicy.preview.ciAttempts', { count: policy.ciMaxAttempts }, policy.ciMaxAttempts)
        }}
      </p>
    </div>
  </div>
</template>
