<script setup lang="ts">
// The Budget configuration screen: the three spend-budget tiers (workspace, account,
// user). The workspace tier is a per-workspace monthly limit + currency; the account and
// user tiers are monthly ceilings that gate a run when EITHER is exhausted. When the
// operator sets a hard cap env var, the account/user input cannot exceed it and the cap is
// shown here. See docs/initiatives/tiered-budgets.md.
import { computed, reactive, ref, watch } from 'vue'

const { t, n } = useI18n()
const toast = useToast()

const settingsStore = useWorkspaceSettingsStore()
const userSettingsStore = useUserSettingsStore()
const accounts = useAccountsStore()
const workspace = useWorkspaceStore()

const caps = computed(() => workspace.budgetCaps)
const capCurrency = computed(() => caps.value?.currency ?? 'EUR')
const money = (value: number) => n(value, { key: 'currency', currency: capCurrency.value })

// ---- Workspace tier -------------------------------------------------------
const wsDraft = reactive({ spendCurrency: '', spendMonthlyLimit: '' })
function hydrateWorkspace() {
  const s = settingsStore.settings
  wsDraft.spendCurrency = s.spendCurrency ?? ''
  wsDraft.spendMonthlyLimit = s.spendMonthlyLimit == null ? '' : String(s.spendMonthlyLimit)
}
watch(() => settingsStore.settings, hydrateWorkspace, { immediate: true })

const savingWorkspace = ref(false)
async function saveWorkspace() {
  savingWorkspace.value = true
  const raw = String(wsDraft.spendMonthlyLimit ?? '').trim()
  try {
    await settingsStore.update({
      spendCurrency: wsDraft.spendCurrency.trim()
        ? wsDraft.spendCurrency.trim().toUpperCase()
        : null,
      spendMonthlyLimit: raw === '' ? null : Number(raw),
    })
    await useWorkspaceStore().refresh()
    toast.add({ title: t('settings.workspaceSettings.toast.budgetSaved'), color: 'success' })
  } catch {
    toast.add({ title: t('settings.workspaceSettings.toast.budgetSaveFailed'), color: 'error' })
  } finally {
    savingWorkspace.value = false
  }
}

// ---- Account tier ---------------------------------------------------------
const account = computed(() => accounts.activeAccount)
const canEditAccount = computed(() => account.value?.roles?.includes('admin') ?? false)
const accountCap = computed(() => caps.value?.accountMonthlyLimitMax ?? null)
const accountDraft = ref('')
watch(
  account,
  (a) => {
    accountDraft.value = a?.spendMonthlyLimit == null ? '' : String(a.spendMonthlyLimit)
  },
  { immediate: true },
)
const accountOverCap = computed(
  () =>
    accountCap.value != null &&
    accountDraft.value.trim() !== '' &&
    Number(accountDraft.value) > accountCap.value,
)
const savingAccount = ref(false)
async function saveAccount() {
  if (!account.value || accountOverCap.value) return
  savingAccount.value = true
  const raw = accountDraft.value.trim()
  try {
    await accounts.setSpendMonthlyLimit(account.value.id, raw === '' ? null : Number(raw))
    await useWorkspaceStore().refresh()
    toast.add({ title: t('settings.workspaceSettings.toast.budgetSaved'), color: 'success' })
  } catch {
    toast.add({ title: t('settings.workspaceSettings.toast.budgetSaveFailed'), color: 'error' })
  } finally {
    savingAccount.value = false
  }
}

// ---- User tier ------------------------------------------------------------
const userCap = computed(() => caps.value?.userMonthlyLimitMax ?? null)
const userDraft = ref('')
watch(
  () => userSettingsStore.settings,
  (s) => {
    userDraft.value = s.spendMonthlyLimit == null ? '' : String(s.spendMonthlyLimit)
  },
  { immediate: true },
)
const userOverCap = computed(
  () =>
    userCap.value != null &&
    userDraft.value.trim() !== '' &&
    Number(userDraft.value) > userCap.value,
)
const savingUser = ref(false)
async function saveUser() {
  if (userOverCap.value) return
  savingUser.value = true
  const raw = userDraft.value.trim()
  try {
    await userSettingsStore.update({ spendMonthlyLimit: raw === '' ? null : Number(raw) })
    await useWorkspaceStore().refresh()
    toast.add({ title: t('settings.workspaceSettings.toast.budgetSaved'), color: 'success' })
  } catch {
    toast.add({ title: t('settings.workspaceSettings.toast.budgetSaveFailed'), color: 'error' })
  } finally {
    savingUser.value = false
  }
}
</script>

<template>
  <div class="space-y-8">
    <p class="text-[11px] text-slate-400">
      {{ t('settings.workspaceSettings.budget.body') }}
    </p>

    <!-- Workspace tier -->
    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('settings.workspaceSettings.budget.workspace') }}
      </h3>
      <div class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.workspaceSettings.budget.monthlyLimit') }}
          </span>
          <UInput
            v-model="wsDraft.spendMonthlyLimit"
            type="number"
            :min="0"
            :placeholder="t('settings.workspaceSettings.budget.defaultPlaceholder')"
            size="sm"
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('settings.workspaceSettings.budget.currency') }}
          </span>
          <UInput
            v-model="wsDraft.spendCurrency"
            placeholder="EUR"
            maxlength="3"
            size="sm"
            class="uppercase"
          />
        </label>
      </div>
      <div v-if="workspace.spend" class="text-[11px] text-slate-400">
        {{
          t('settings.workspaceSettings.budget.spent', {
            spent: money(workspace.spend.costSpent),
            limit: money(workspace.spend.costLimit),
          })
        }}
      </div>
      <div class="flex justify-end">
        <UButton
          color="primary"
          icon="i-lucide-save"
          size="sm"
          :loading="savingWorkspace"
          @click="saveWorkspace"
        >
          {{ t('settings.workspaceSettings.budget.saveTier') }}
        </UButton>
      </div>
    </section>

    <!-- Account tier -->
    <section v-if="account" class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('settings.workspaceSettings.budget.account') }}
      </h3>
      <p class="text-[11px] text-slate-400">
        {{ t('settings.workspaceSettings.budget.accountBody') }}
      </p>
      <label class="block">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.workspaceSettings.budget.monthlyLimit') }}
        </span>
        <UInput
          v-model="accountDraft"
          type="number"
          :min="0"
          :max="accountCap ?? undefined"
          :disabled="!canEditAccount"
          :placeholder="t('settings.workspaceSettings.budget.noLimitPlaceholder')"
          size="sm"
        />
      </label>
      <p
        v-if="accountCap != null"
        class="text-[11px]"
        :class="accountOverCap ? 'text-rose-400' : 'text-amber-400'"
      >
        {{ t('settings.workspaceSettings.budget.hardCap', { amount: money(accountCap) }) }}
        <span class="text-slate-500"
          >({{ t('settings.workspaceSettings.budget.hardCapHint') }})</span
        >
      </p>
      <div v-if="workspace.accountSpend" class="text-[11px] text-slate-400">
        {{
          t('settings.workspaceSettings.budget.spent', {
            spent: money(workspace.accountSpend.costSpent),
            limit: money(workspace.accountSpend.costLimit),
          })
        }}
      </div>
      <p v-if="!canEditAccount" class="text-[11px] text-slate-500">
        {{ t('settings.workspaceSettings.budget.adminOnly') }}
      </p>
      <div v-if="canEditAccount" class="flex justify-end">
        <UButton
          color="primary"
          icon="i-lucide-save"
          size="sm"
          :loading="savingAccount"
          :disabled="accountOverCap"
          @click="saveAccount"
        >
          {{ t('settings.workspaceSettings.budget.saveTier') }}
        </UButton>
      </div>
    </section>

    <!-- User tier -->
    <section class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-200">
        {{ t('settings.workspaceSettings.budget.user') }}
      </h3>
      <p class="text-[11px] text-slate-400">
        {{ t('settings.workspaceSettings.budget.userBody') }}
      </p>
      <label class="block">
        <span class="mb-1 block text-[10px] uppercase tracking-wide text-slate-500">
          {{ t('settings.workspaceSettings.budget.monthlyLimit') }}
        </span>
        <UInput
          v-model="userDraft"
          type="number"
          :min="0"
          :max="userCap ?? undefined"
          :placeholder="t('settings.workspaceSettings.budget.noLimitPlaceholder')"
          size="sm"
        />
      </label>
      <p
        v-if="userCap != null"
        class="text-[11px]"
        :class="userOverCap ? 'text-rose-400' : 'text-amber-400'"
      >
        {{ t('settings.workspaceSettings.budget.hardCap', { amount: money(userCap) }) }}
        <span class="text-slate-500"
          >({{ t('settings.workspaceSettings.budget.hardCapHint') }})</span
        >
      </p>
      <div v-if="workspace.userSpend" class="text-[11px] text-slate-400">
        {{
          t('settings.workspaceSettings.budget.spent', {
            spent: money(workspace.userSpend.costSpent),
            limit: money(workspace.userSpend.costLimit),
          })
        }}
      </div>
      <div class="flex justify-end">
        <UButton
          color="primary"
          icon="i-lucide-save"
          size="sm"
          :loading="savingUser"
          :disabled="userOverCap"
          @click="saveUser"
        >
          {{ t('settings.workspaceSettings.budget.saveTier') }}
        </UButton>
      </div>
    </section>
  </div>
</template>
