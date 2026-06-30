<script setup lang="ts">
// The board (workspace-tier) prompt-fragment library modal (ADR 0006). A thin shell
// around the shared FragmentLibraryManager at the active board's scope — including
// the resolved/merged catalog view so the built-in ∪ account ∪ workspace inheritance
// is visible. Opened from the navbar / command bar via the ui store.
import FragmentLibraryManager from '~/components/fragments/FragmentLibraryManager.vue'

const ui = useUiStore()
const workspace = useWorkspaceStore()
const { t } = useI18n()

const open = computed({
  get: () => ui.fragmentLibraryOpen,
  set: (v: boolean) => {
    if (!v) ui.closeFragmentLibrary()
  },
})
</script>

<template>
  <UModal v-model:open="open" :title="t('fragments.panel.title')" :ui="{ content: 'max-w-3xl' }">
    <template #body>
      <FragmentLibraryManager
        v-if="workspace.workspaceId"
        kind="workspace"
        :owner-id="workspace.workspaceId"
        show-catalog
      />
    </template>
  </UModal>
</template>
