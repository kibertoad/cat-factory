<script setup lang="ts">
// Account-tier risk policies (ADR 0055): the merge postures an org authors once, which every board
// in the account inherits read-only and may clone or hide. A body-only section rendered in the "Risk
// policies" tab of AccountSettingsPanel.
//
// The SAME editor rows the board panel uses, with the default-claim controls off: which policy
// governs a task that pinned none is a per-board question, so an account row holds no default and a
// promote button here would be a control over a decision this tier never makes.
import { computed, onMounted, ref, watch } from 'vue'
import type {
  CreateRiskPolicyInput,
  RiskPolicyLibraryEntry,
  UpdateRiskPolicyInput,
} from '~/types/merge'
import RiskPolicyCreateForm from '~/components/settings/RiskPolicyCreateForm.vue'
import RiskPolicyEditorRow from '~/components/settings/RiskPolicyEditorRow.vue'

const props = defineProps<{ accountId: string }>()

const { t } = useI18n()
const store = useAccountRiskPoliciesStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { confirm } = useConfirm()

const busy = ref<string | null>(null)
const creating = ref(false)

const policies = computed<RiskPolicyLibraryEntry[]>(() => store.policies(props.accountId))

onMounted(() => void load())
// Switching accounts re-reads rather than showing the previous account's library.
watch(
  () => props.accountId,
  () => void load(),
)

async function load() {
  try {
    await store.load(props.accountId)
  } catch (e) {
    present(e, 'layout.accountRiskPolicies.loadFailed')
  }
}

async function save(policy: RiskPolicyLibraryEntry, patch: UpdateRiskPolicyInput) {
  busy.value = policy.id
  try {
    await store.update(props.accountId, policy.id, patch)
    toast.add({
      title: t('settings.riskPolicy.toast.saved'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.riskPolicy.toast.saveFailed')
  } finally {
    busy.value = null
  }
}

async function remove(policy: RiskPolicyLibraryEntry) {
  const ok = await confirm({
    title: t('settings.riskPolicy.confirmDelete.title'),
    // Its own copy rather than the board's: withdrawing an account policy changes what EVERY board
    // in the account can pin, and a task that pinned it falls back to its board's own default.
    description: t('layout.accountRiskPolicies.confirmDelete', { name: policy.name }),
    variant: 'destructive',
    confirmLabel: t('common.delete'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  busy.value = policy.id
  try {
    await store.remove(props.accountId, policy.id)
  } catch (e) {
    present(e, 'settings.riskPolicy.toast.deleteFailed')
  } finally {
    busy.value = null
  }
}

async function create(input: CreateRiskPolicyInput) {
  creating.value = true
  try {
    await store.create(props.accountId, input)
    toast.add({
      title: t('settings.riskPolicy.toast.created'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.riskPolicy.toast.createFailed')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="space-y-4 text-sm" data-testid="account-risk-policy-panel">
    <p class="text-[11px] text-slate-400">{{ t('layout.accountRiskPolicies.intro') }}</p>

    <p v-if="!store.loading && policies.length === 0" class="text-[11px] text-slate-500">
      {{ t('layout.accountRiskPolicies.empty') }}
    </p>

    <RiskPolicyEditorRow
      v-for="policy in policies"
      :key="policy.id"
      :policy="policy"
      :busy="busy"
      :show-defaults="false"
      @save="save(policy, $event)"
      @remove="remove(policy)"
    />

    <RiskPolicyCreateForm :busy="creating" @create="create($event)" />
  </div>
</template>
