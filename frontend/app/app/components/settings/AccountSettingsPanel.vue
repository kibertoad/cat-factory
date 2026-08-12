<script setup lang="ts">
// Account settings — a single tabbed modal for the per-account configuration, distinct
// from Workspace settings. Hosts the team panel (members + roles, invitations, email
// sender, account-wide API keys; org-scoped, with a create-org CTA on a personal account)
// the account-tier prompt-fragment library, the repo-sourced skills, the foundational-service
// catalog and the account-tier risk policies (all available for every account type).
// Opened from the SideBar Configuration section, the account switcher and the command
// bar; bound to the `ui` store so any surface can open it and deep-link to a tab.
import AccountTeamSettings from '~/components/layout/AccountTeamSettings.vue'
import AccountFragmentSettings from '~/components/layout/AccountFragmentSettings.vue'
import AccountSkillSettings from '~/components/layout/AccountSkillSettings.vue'
import AccountFoundationalSettings from '~/components/layout/AccountFoundationalSettings.vue'
import AccountRiskPolicySettings from '~/components/layout/AccountRiskPolicySettings.vue'

const { t } = useI18n()
const ui = useUiStore()
const accounts = useAccountsStore()

const open = computed({
  get: () => ui.accountSettingsOpen,
  set: (v: boolean) => (v ? ui.openAccountSettings() : ui.closeAccountSettings()),
})

// Driven by the ui store so other surfaces (command bar, the workspace-settings
// cross-link) can deep-link straight to a tab.
const activeTab = computed({
  get: () => ui.accountSettingsTab,
  set: (v: string) => ui.setAccountSettingsTab(v),
})

const tabs = computed(() => [
  { value: 'team', label: t('settings.account.tabs.team'), icon: 'i-lucide-users', slot: 'team' },
  {
    value: 'fragments',
    label: t('settings.account.tabs.fragments'),
    icon: 'i-lucide-book-marked',
    slot: 'fragments',
  },
  {
    value: 'skills',
    label: t('settings.account.tabs.skills'),
    icon: 'i-lucide-book-open-check',
    slot: 'skills',
  },
  {
    value: 'foundational',
    label: t('settings.account.tabs.foundational'),
    icon: 'i-lucide-boxes',
    slot: 'foundational',
  },
  {
    value: 'riskPolicies',
    label: t('settings.account.tabs.riskPolicies'),
    icon: 'i-lucide-shield-check',
    slot: 'riskPolicies',
  },
])
</script>

<template>
  <UModal v-model:open="open" :title="t('settings.account.title')" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <p v-if="!accounts.activeAccountId" class="text-sm text-slate-400">
        {{ t('settings.account.noAccount') }}
      </p>
      <UTabs
        v-else
        v-model="activeTab"
        :items="tabs"
        variant="link"
        :ui="{ root: 'gap-4', list: 'overflow-x-auto' }"
      >
        <template #team>
          <AccountTeamSettings :account-id="accounts.activeAccountId" />
        </template>
        <template #fragments>
          <AccountFragmentSettings :account-id="accounts.activeAccountId" />
        </template>
        <template #foundational>
          <!-- Key on the account for the same reason the skills tab is: a mid-modal account
               switch must remount against a fresh owner-keyed store, not the stale initial one. -->
          <AccountFoundationalSettings
            :key="accounts.activeAccountId ?? undefined"
            :account-id="accounts.activeAccountId"
          />
        </template>
        <template #riskPolicies>
          <!-- Keyed on the account like its siblings: a mid-modal account switch must remount
               against a fresh account-keyed store rather than the stale initial one. -->
          <AccountRiskPolicySettings
            :key="accounts.activeAccountId ?? undefined"
            :account-id="accounts.activeAccountId"
          />
        </template>
        <template #skills>
          <!-- Key on the account so a mid-modal account switch remounts against a fresh
               account-keyed skill-library store rather than the stale initial one. -->
          <AccountSkillSettings
            :key="accounts.activeAccountId ?? undefined"
            :account-id="accounts.activeAccountId"
          />
        </template>
      </UTabs>
    </template>
  </UModal>
</template>
