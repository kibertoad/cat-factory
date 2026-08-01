<script setup lang="ts">
// The board (workspace-tier) foundational-services modal
// (backend/docs/adr/0031-foundational-services.md). A thin shell around the shared manager at the
// active board's scope — including the merged catalog, so the account ⊕ workspace inheritance an
// Architect designs against is visible and the board can opt out of an inherited service.
// Opened from the navbar / command bar via the ui store.
import FoundationalServiceManager from '~/components/foundational/FoundationalServiceManager.vue'

const ui = useUiStore()
const workspace = useWorkspaceStore()
const { t } = useI18n()

const open = computed({
  get: () => ui.foundationalServicesOpen,
  set: (v: boolean) => {
    if (!v) ui.closeFoundationalServices()
  },
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('foundational.panel.title')"
    :description="t('foundational.panel.subtitle')"
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <FoundationalServiceManager
        v-if="workspace.workspaceId"
        kind="workspace"
        :owner-id="workspace.workspaceId"
        show-catalog
      />
    </template>
  </UModal>
</template>
