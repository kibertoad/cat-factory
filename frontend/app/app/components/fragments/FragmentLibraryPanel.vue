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
      <!-- The anchor for the tutorial tour about steering agents with standards, which points at
           the library as a whole. Named HERE rather than inside the manager because that manager
           is mounted at two scopes (this modal and the account settings' fragment tab), so an id
           on its root would be one id over two elements, leaving which one the tour highlights to
           DOM order. A wrapper rather than an attribute passed down to it, because the anchor
           DRIFT GUARD reads test ids out of the templates that write them: Vue's attribute
           fallthrough would still satisfy the guard on the day someone adds a second root node to
           the manager and the anchor stops rendering.
           The tour requires the library to be enabled, so it never lands on the manager's own
           unavailable notice. -->
      <div data-testid="fragment-library">
        <FragmentLibraryManager
          v-if="workspace.workspaceId"
          kind="workspace"
          :owner-id="workspace.workspaceId"
          show-catalog
        />
      </div>
    </template>
  </UModal>
</template>
