<script setup lang="ts">
// Account & team settings — a modal host for the per-account team panel (members +
// roles, invitations, email sender, account-wide API keys). Account-scoped, distinct
// from Workspace settings. Opened from the SideBar Configuration section and the
// account switcher; bound to the `ui` store so any surface can open it.
import AccountTeamSettings from '~/components/layout/AccountTeamSettings.vue'

const ui = useUiStore()
const accounts = useAccountsStore()

const open = computed({
  get: () => ui.accountSettingsOpen,
  set: (v: boolean) => (v ? ui.openAccountSettings() : ui.closeAccountSettings()),
})
</script>

<template>
  <UModal v-model:open="open" title="Account & team" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <AccountTeamSettings v-if="accounts.activeAccountId" :account-id="accounts.activeAccountId" />
      <p v-else class="text-sm text-slate-400">No account selected.</p>
    </template>
  </UModal>
</template>
