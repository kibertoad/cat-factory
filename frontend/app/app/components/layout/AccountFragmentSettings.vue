<script setup lang="ts">
// Account-tier prompt-fragment library (ADR 0006): best-practice guidelines shared by
// every board in the account, which each board inherits and can override. A body-only
// section rendered in the "Context fragments" tab of AccountSettingsPanel; available for
// ALL account types (unlike the org-only Team tab).
import { computed } from 'vue'
import FragmentLibraryManager from '~/components/fragments/FragmentLibraryManager.vue'

const props = defineProps<{ accountId: string }>()
const workspace = useWorkspaceStore()
const { t } = useI18n()

// Account-tier document fragments are fetched through a board's stored
// document-source connection (credentials are per-workspace). Prefer the active
// board when it belongs to this account, else the account's first board.
const viaWorkspaceId = computed(() => {
  const boards = workspace.accountWorkspaces
  return boards.find((w) => w.id === workspace.workspaceId)?.id ?? boards[0]?.id
})
</script>

<template>
  <div class="space-y-6 text-sm">
    <section>
      <p class="mb-3 text-[11px] text-slate-400">
        {{ t('layout.accountFragments.intro') }}
      </p>
      <FragmentLibraryManager
        kind="account"
        :owner-id="accountId"
        :via-workspace-id="viaWorkspaceId"
        :show-catalog="false"
      />
    </section>
  </div>
</template>
