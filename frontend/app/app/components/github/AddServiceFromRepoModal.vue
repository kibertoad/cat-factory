<script setup lang="ts">
// Add a board service backed by an EXISTING GitHub repository — no bootstrap
// run. Unlike the bootstrap modal (which creates a repo and has an agent adapt
// it in a container), this just links a repo the App can access to a fresh,
// `ready` service frame. The workspace need not track the repo yet: the backend
// links + syncs it on import. If the App can't see the wanted repo, the user
// grants it access from here, then refreshes the list.
import GitHubConnect from '~/components/github/GitHubConnect.vue'

const ui = useUiStore()
const github = useGitHubStore()
const board = useBoardStore()
const toast = useToast()

const open = computed({
  get: () => ui.addServiceOpen,
  set: (v: boolean) => {
    if (!v) ui.closeAddService()
  },
})

const selectedRepoId = ref<number | undefined>(undefined)
const adding = ref(false)

async function loadRepos() {
  try {
    await github.probe()
    if (github.connected) await Promise.all([github.load(), github.loadAvailableRepos()])
  } catch {
    // Integration off / unreachable → the picker stays empty, GitHubConnect shows.
  }
}

// On open: ensure we know the connection + which repos the App can access, and
// the workspace's already-tracked repos (to flag ones already on the board).
watch(open, (isOpen) => {
  if (!isOpen) return
  selectedRepoId.value = undefined
  void loadRepos()
})

// If the user connects from inside the modal (the not-connected prompt), pull the
// repo list as soon as the connection is bound.
watch(
  () => github.connected,
  (isConnected) => {
    if (isConnected && open.value) void loadRepos()
  },
)

// The integration is on but this workspace isn't bound yet — connect first.
const needsGitHub = computed(() => github.available === true && !github.connected)

// Repos already backing a board service can't be added again.
const onBoardIds = computed(
  () => new Set(github.repos.filter((r) => r.blockId).map((r) => r.githubId)),
)

const repoItems = computed(() =>
  github.availableRepos.map((r) => {
    const onBoard = onBoardIds.value.has(r.githubId)
    return {
      label: `${r.owner}/${r.name}${r.private ? ' (private)' : ''}${onBoard ? ' · already on board' : ''}`,
      value: r.githubId,
      disabled: onBoard,
    }
  }),
)

const hasRepos = computed(() => github.availableRepos.length > 0)

// The App's installation settings page — where the user grants it access to a
// repo it can't see yet (mirrors the bootstrap modal's "grant access" link).
const manageInstallUrl = computed(() => {
  const conn = github.connection
  if (!conn) return undefined
  return conn.targetType === 'Organization'
    ? `https://github.com/organizations/${conn.accountLogin}/settings/installations/${conn.installationId}`
    : `https://github.com/settings/installations/${conn.installationId}`
})

function openManageInstall() {
  if (manageInstallUrl.value) window.open(manageInstallUrl.value, '_blank', 'noopener')
}

const canAdd = computed(() => !needsGitHub.value && selectedRepoId.value !== undefined)

async function add() {
  if (!canAdd.value || selectedRepoId.value === undefined) return
  adding.value = true
  try {
    const block = await board.addServiceFromRepo(selectedRepoId.value)
    // Refresh the projection so the new repo↔block link is reflected locally.
    await github.load()
    toast.add({
      title: 'Service added',
      description: `${block.title} is now on the board.`,
      icon: 'i-lucide-check',
      color: 'success',
    })
    ui.closeAddService()
  } catch (e) {
    toast.add({
      title: 'Could not add service',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Add a service from a repository" :ui="{ content: 'max-w-xl' }">
    <template #body>
      <div class="space-y-6">
        <p class="text-sm text-slate-400">
          Pick an existing GitHub repository to add as a board service. No bootstrapping — the repo
          is linked to a new service frame as-is, and tasks you run on it target that repo.
        </p>

        <!-- not connected: linking a repo needs the App bound to this workspace -->
        <div
          v-if="needsGitHub"
          class="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
        >
          <div class="flex items-start gap-2">
            <UIcon name="i-lucide-plug-zap" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p class="text-sm text-amber-200/90">
              Connect this workspace to GitHub first. Link an installation the App is already on, or
              install it.
            </p>
          </div>
          <GitHubConnect />
        </div>

        <template v-else>
          <UFormField
            label="Repository"
            description="Repositories the GitHub App can access. Don't see yours? Grant the App access below, then refresh."
            required
          >
            <div v-if="!hasRepos" class="text-sm text-slate-400">
              No repositories available yet — grant the App access to one below, then refresh.
            </div>
            <USelect
              v-else
              v-model="selectedRepoId"
              :items="repoItems"
              placeholder="Choose a repository"
              class="w-full"
            />
          </UFormField>

          <div class="flex flex-wrap items-center gap-2">
            <UButton
              v-if="manageInstallUrl"
              color="neutral"
              variant="subtle"
              size="sm"
              icon="i-lucide-shield-check"
              trailing-icon="i-lucide-external-link"
              title="Open the App's installation settings to grant it access to a repository"
              @click="openManageInstall"
            >
              Grant the App access to a repo
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-refresh-cw"
              :loading="github.loadingAvailable"
              @click="github.loadAvailableRepos()"
            >
              Refresh list
            </UButton>
          </div>

          <div class="flex justify-end">
            <UButton
              color="primary"
              icon="i-lucide-plus"
              :loading="adding"
              :disabled="!canAdd"
              @click="add"
            >
              Add service
            </UButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
