<script setup lang="ts">
// Account settings for the active account (personal or org). Today its primary
// surface is the account-tier prompt-fragment library (ADR 0006): best-practice
// guidelines shared by every board in the account, which each board inherits and
// can override. Reachable for ALL account types (unlike the org-only Team settings).
import { computed } from 'vue'
import FragmentLibraryManager from '~/components/fragments/FragmentLibraryManager.vue'

const props = defineProps<{ accountId: string }>()
const workspace = useWorkspaceStore()

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
      <h3 class="mb-1 font-semibold text-white">Context fragments</h3>
      <p class="mb-3 text-[11px] text-slate-400">
        Best-practice guidelines shared by every board in this account. Each board inherits these
        and can override or add its own. Code-aware agents (coder, reviewer, architect, fixers) fold
        the relevant ones into their prompt.
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
