<script setup lang="ts">
// The Budget configuration screen: the three spend-budget tiers (workspace, account,
// user). The workspace tier is a per-workspace monthly limit + currency; the account and
// user tiers are monthly ceilings that gate a run when EITHER is exhausted. When the
// operator sets a hard cap env var, the account/user input cannot exceed it and the cap is
// shown here. See docs/initiatives/tiered-budgets.md.
import { computed, reactive, ref, watch, type Ref } from 'vue'

const { t, n } = useI18n()
const toast = useToast()

const settingsStore = useWorkspaceSettingsStore()
const userSettingsStore = useUserSettingsStore()
const accounts = useAccountsStore()
const workspace = useWorkspaceStore()

const caps = computed(() => workspace.budgetCaps)
const capCurrency = computed(() => caps.value?.currency ?? 'EUR')
// Format an amount in a given currency. The account/user tiers are in the base pricing
// currency (`capCurrency`); the workspace tier is in its OWN overridden `spend.currency`, so
// its callers pass that in — otherwise a USD workspace on a EUR deployment renders `€` on USD.
const money = (value: number, currency: string = capCurrency.value) =>
  n(value, { key: 'currency', currency })

// Persist one tier's budget: save, toast success, then best-effort refresh the snapshot AFTER
// the save has succeeded. A transient snapshot-refresh failure must NOT report a persisted
// budget as failed (the spend meter also catches up on the next pushed snapshot); a genuine
// save rejection surfaces its message so the user sees why (e.g. the operator hard-cap reject).
async function runSave(saving: Ref<boolean>, save: () => Promise<unknown>) {
  saving.value = true
  try {
    await save()
    toast.add({ title: t('settings.workspaceSettings.toast.budgetSaved'), color: 'success' })
    try {
      await useWorkspaceStore().refresh()
    } catch {
      // ignore — the budget is persisted; the meter will catch up on the next snapshot.
    }
  } catch (e) {
    toast.add({
      title: t('settings.workspaceSettings.toast.budgetSaveFailed'),
      description: e instanceof Error ? e.message : String(e),
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

// ---- Workspace tier -------------------------------------------------------
const wsDraft = reactive({ spendCurrency: '', spendMonthlyLimit: '' })
function hydrateWorkspace() {
  const s = settingsStore.settings
  wsDraft.spendCurrency = s.spendCurrency ?? ''
  wsDraft.spendMonthlyLimit = s.spendMonthlyLimit == null ? '' : String(s.spendMonthlyLimit)
}
watch(() => settingsStore.settings, hydrateWorkspace, { immediate: true })

const savingWorkspace = ref(false)
function saveWorkspace() {
  const raw = String(wsDraft.spendMonthlyLimit ?? '').trim()
  return runSave(savingWorkspace, () =>
    settingsStore.update({
      spendCurrency: wsDraft.spendCurrency.trim()
        ? wsDraft.spendCurrency.trim().toUpperCase()
        : null,
      spendMonthlyLimit: raw === '' ? null : Number(raw),
    }),
  )
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
function saveAccount() {
  const acc = account.value
  if (!acc || accountOverCap.value) return
  const raw = accountDraft.value.trim()
  return runSave(savingAccount, () =>
    accounts.setSpendMonthlyLimit(acc.id, raw === '' ? null : Number(raw)),
  )
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
function saveUser() {
  if (userOverCap.value) return
  const raw = userDraft.value.trim()
  return runSave(savingUser, () =>
    userSettingsStore.update({ spendMonthlyLimit: raw === '' ? null : Number(raw) }),
  )
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
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            spent: money(workspace.spend.costSpent, workspace.spend.currency),
            limit: money(workspace.spend.costLimit, workspace.spend.currency),
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
