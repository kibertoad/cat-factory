<script setup lang="ts">
// One risk policy this board INHERITS from its account (ADR 0055): read-only, with the two actions
// a board actually has over a row it does not own.
//
// A summary rather than a disabled copy of the editor. Rendering the full form greyed out would
// suggest the numbers are a click away from editable when the remedy is a different act entirely
// (clone it, then edit the copy), and it would put twenty inert controls on screen to say so. The
// summary itself is `RiskPolicyPreview`, the same component the task picker explains a policy with,
// so what a policy MEANS is worded one way everywhere.
import type { RiskPolicyLibraryEntry } from '~/types/merge'
import RiskPolicyPreview from '~/components/riskPolicy/RiskPolicyPreview.vue'

defineProps<{
  policy: RiskPolicyLibraryEntry
  /** Which single control is mid-request, keyed `<policyId>:<action>` by the owning panel. */
  busy: string | null
}>()

const emit = defineEmits<{ clone: []; hide: [] }>()

const { t } = useI18n()
</script>

<template>
  <div
    class="rounded-lg border border-slate-700/70 bg-slate-900/30 p-3"
    data-testid="risk-policy-inherited-row"
    :data-policy-id="policy.id"
    :data-policy-tier="policy.tier"
  >
    <div class="mb-2 flex flex-wrap items-center justify-end gap-2">
      <UBadge
        color="neutral"
        variant="subtle"
        size="sm"
        class="mr-auto"
        :title="t('settings.riskPolicy.tier.accountHint')"
      >
        {{ t('settings.riskPolicy.tier.account') }}
      </UBadge>
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-copy"
        :loading="busy === `${policy.id}:clone`"
        :title="t('settings.riskPolicy.inherited.cloneHint')"
        data-testid="risk-policy-clone"
        @click="emit('clone')"
      >
        {{ t('settings.riskPolicy.inherited.clone') }}
      </UButton>
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-eye-off"
        :loading="busy === `${policy.id}:hide`"
        :title="t('settings.riskPolicy.inherited.hideHint')"
        data-testid="risk-policy-hide"
        @click="emit('hide')"
      >
        {{ t('settings.riskPolicy.inherited.hide') }}
      </UButton>
    </div>

    <RiskPolicyPreview :policy="policy" />
  </div>
</template>
