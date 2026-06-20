<script setup lang="ts">
// Add a board service backed by an EXISTING GitHub repository — no bootstrap
// run. Unlike the bootstrap modal (which creates a repo and has an agent adapt
// it in a container), this just links a repo the App can access to a fresh,
// `ready` service frame. The workspace need not track the repo yet: the backend
// links + syncs it on import. If the App can't see the wanted repo, the user
// grants it access from here, then refreshes the list.
//
// MONOREPO support: a repo flagged a monorepo can back SEVERAL services, each
// pinned to a subdirectory. When the selected repo is a monorepo, the user
// browses its tree and picks the service's directory before adding (and may add
// more than one, a subset of the repo's services).
import GitHubConnect from '~/components/github/GitHubConnect.vue'
import type { RepoTreeEntry } from '~/types/domain'

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
  resetSelection()
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

// Repos already backing a board service can't be added again — UNLESS they're a
// monorepo, which can host several services (each at its own subdirectory).
const onBoardIds = computed(
  () => new Set(github.repos.filter((r) => r.blockId).map((r) => r.githubId)),
)

const repoItems = computed(() =>
  github.availableRepos.map((r) => {
    const onBoard = onBoardIds.value.has(r.githubId) && !r.isMonorepo
    const mono = r.isMonorepo ? ' · monorepo' : ''
    return {
      label: `${r.owner}/${r.name}${r.private ? ' (private)' : ''}${mono}${onBoard ? ' · already on board' : ''}`,
      value: r.githubId,
      disabled: onBoard,
    }
  }),
)

const hasRepos = computed(() => github.availableRepos.length > 0)
const selectedRepo = computed(() =>
  github.availableRepos.find((r) => r.githubId === selectedRepoId.value),
)
const isMonorepo = computed(() => selectedRepo.value?.isMonorepo === true)

// ---- monorepo flag + directory browser ----------------------------------

const settingMonorepo = ref(false)
async function toggleMonorepo(value: boolean) {
  if (selectedRepoId.value === undefined) return
  settingMonorepo.value = true
  try {
    await github.setMonorepo(selectedRepoId.value, value)
    selectedDirectory.value = undefined
    if (value) await browseTo('')
  } catch (e) {
    toast.add({
      title: 'Could not update repository',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    settingMonorepo.value = false
  }
}

const currentPath = ref('')
const treeEntries = ref<RepoTreeEntry[]>([])
const loadingTree = ref(false)
const selectedDirectory = ref<string | undefined>(undefined)

const dirEntries = computed(() => treeEntries.value.filter((e) => e.type === 'dir'))
const breadcrumbs = computed(() => {
  const segments = currentPath.value ? currentPath.value.split('/') : []
  let acc = ''
  return segments.map((seg) => {
    acc = acc ? `${acc}/${seg}` : seg
    return { label: seg, path: acc }
  })
})

async function browseTo(path: string) {
  if (selectedRepoId.value === undefined) return
  loadingTree.value = true
  try {
    currentPath.value = path
    treeEntries.value = await github.loadRepoTree(selectedRepoId.value, path)
  } catch (e) {
    treeEntries.value = []
    toast.add({
      title: 'Could not list directory',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    loadingTree.value = false
  }
}

// When the selected repo changes, load its tree if it's already a monorepo.
watch(selectedRepoId, () => {
  selectedDirectory.value = undefined
  currentPath.value = ''
  treeEntries.value = []
  if (isMonorepo.value) void browseTo('')
})

function resetSelection() {
  selectedRepoId.value = undefined
  selectedDirectory.value = undefined
  currentPath.value = ''
  treeEntries.value = []
}

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

// A monorepo service needs a chosen directory; a whole-repo service does not.
const canAdd = computed(
  () =>
    !needsGitHub.value &&
    selectedRepoId.value !== undefined &&
    (!isMonorepo.value || !!selectedDirectory.value),
)

async function add() {
  if (!canAdd.value || selectedRepoId.value === undefined) return
  adding.value = true
  try {
    const block = await board.addServiceFromRepo(
      selectedRepoId.value,
      isMonorepo.value ? selectedDirectory.value : undefined,
    )
    // Refresh the projection so the new repo↔block link is reflected locally.
    await github.load()
    toast.add({
      title: 'Service added',
      description: `${block.title} is now on the board.`,
      icon: 'i-lucide-check',
      color: 'success',
    })
    // For a monorepo keep the modal open so the user can add more of its services;
    // otherwise close as before.
    if (isMonorepo.value) {
      selectedDirectory.value = undefined
    } else {
      ui.closeAddService()
    }
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

          <!-- monorepo handling: flag + directory picker -->
          <div v-if="selectedRepoId !== undefined" class="space-y-3">
            <USwitch
              :model-value="isMonorepo"
              :loading="settingMonorepo"
              label="This is a monorepo (hosts more than one service)"
              description="Flag the repo so you can add several services from it, each pinned to a subdirectory."
              @update:model-value="toggleMonorepo"
            />

            <div
              v-if="isMonorepo"
              class="rounded-md border border-slate-700/60 bg-slate-900/40 p-3"
            >
              <p class="mb-2 text-xs text-slate-400">
                Browse the repository and pick the directory of the service you want to add. Agents
                working on this service will run within that subdirectory.
              </p>

              <!-- breadcrumbs -->
              <div class="mb-2 flex flex-wrap items-center gap-1 text-sm">
                <UButton
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  icon="i-lucide-folder-tree"
                  :disabled="loadingTree"
                  @click="browseTo('')"
                >
                  root
                </UButton>
                <template v-for="crumb in breadcrumbs" :key="crumb.path">
                  <span class="text-slate-600">/</span>
                  <UButton
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    :disabled="loadingTree"
                    @click="browseTo(crumb.path)"
                  >
                    {{ crumb.label }}
                  </UButton>
                </template>
              </div>

              <!-- directory list -->
              <div class="max-h-56 overflow-auto rounded border border-slate-800">
                <div v-if="loadingTree" class="p-3 text-sm text-slate-400">Loading…</div>
                <div v-else-if="dirEntries.length === 0" class="p-3 text-sm text-slate-400">
                  No subdirectories here.
                </div>
                <ul v-else class="divide-y divide-slate-800">
                  <li
                    v-for="entry in dirEntries"
                    :key="entry.path"
                    class="flex items-center justify-between gap-2 px-3 py-1.5"
                  >
                    <button
                      type="button"
                      class="flex items-center gap-2 truncate text-sm text-slate-200 hover:text-primary-400"
                      @click="browseTo(entry.path)"
                    >
                      <UIcon name="i-lucide-folder" class="h-4 w-4 shrink-0 text-amber-400" />
                      <span class="truncate">{{ entry.name }}</span>
                    </button>
                    <UButton
                      size="xs"
                      variant="soft"
                      :color="selectedDirectory === entry.path ? 'primary' : 'neutral'"
                      @click="selectedDirectory = entry.path"
                    >
                      {{ selectedDirectory === entry.path ? 'Selected' : 'Select' }}
                    </UButton>
                  </li>
                </ul>
              </div>

              <div class="mt-2 flex items-center justify-between gap-2">
                <p class="truncate text-xs text-slate-400">
                  <template v-if="selectedDirectory">
                    Service directory:
                    <code class="text-slate-200">{{ selectedDirectory }}</code>
                  </template>
                  <template v-else>No directory selected yet.</template>
                </p>
                <UButton
                  v-if="currentPath"
                  size="xs"
                  variant="soft"
                  :color="selectedDirectory === currentPath ? 'primary' : 'neutral'"
                  @click="selectedDirectory = currentPath"
                >
                  Use this folder
                </UButton>
              </div>
            </div>
          </div>

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
