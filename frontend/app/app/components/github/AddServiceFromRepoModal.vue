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
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'
import ServiceTestConfig from '~/components/panels/inspector/ServiceTestConfig.vue'
import ServiceFragments from '~/components/panels/inspector/ServiceFragments.vue'

const { t } = useI18n()
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
    const suffix = [
      r.private ? t('github.addService.repoLabel.private') : '',
      r.isMonorepo ? t('github.addService.repoLabel.monorepo') : '',
      onBoard ? t('github.addService.repoLabel.onBoard') : '',
    ].join('')
    return {
      label: `${r.owner}/${r.name}${suffix}`,
      // Searched on (lowercased once) — the owner/name, so the filter matches either.
      search: `${r.owner}/${r.name}`.toLowerCase(),
      value: r.githubId,
      disabled: onBoard,
    }
  }),
)

// The PAT (or a wide App install) can expose hundreds of repos, too many for a plain
// dropdown — filter by owner/name. The currently selected repo is always kept in the
// list so a selection doesn't vanish when the query no longer matches it.
const repoSearch = ref('')
const filteredRepoItems = computed(() => {
  const q = repoSearch.value.trim().toLowerCase()
  if (!q) return repoItems.value
  return repoItems.value.filter((r) => r.search.includes(q) || r.value === selectedRepoId.value)
})

const hasRepos = computed(() => github.availableRepos.length > 0)
const selectedRepo = computed(() =>
  github.availableRepos.find((r) => r.githubId === selectedRepoId.value),
)

// ---- monorepo flag + directory picker ------------------------------------

// The monorepo flag is MODAL-LOCAL state, sent as part of the add-service request
// rather than persisted up-front on a toggle: there's no need to round-trip a PATCH
// before adding (browsing the tree needs only the repo id, and the backend flags the
// repo + requires a directory when it creates the service). A repo already flagged a
// monorepo (it backs other services) seeds the toggle on when selected.
const isMonorepo = ref(false)
const selectedDirectory = ref<string | undefined>(undefined)

function toggleMonorepo(value: boolean) {
  isMonorepo.value = value
  selectedDirectory.value = undefined
}

// On repo change, seed the toggle from the repo's persisted flag and clear the rest.
watch(selectedRepoId, () => {
  isMonorepo.value = selectedRepo.value?.isMonorepo === true
  selectedDirectory.value = undefined
  configuredBlockId.value = undefined
})

function resetSelection() {
  selectedRepoId.value = undefined
  selectedDirectory.value = undefined
  isMonorepo.value = false
  configuredBlockId.value = undefined
  repoSearch.value = ''
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

// The just-added service, kept on the board store so the user can configure it (test
// infra + fragments) right here — the same controls as the inspector. A monorepo can
// host several services, so adding another keeps the modal open; a whole-repo service
// can only be added once (its repo is then on the board).
const configuredBlockId = ref<string | undefined>(undefined)
const configuredDirectory = ref<string | undefined>(undefined)
const configuredBlock = computed(() =>
  configuredBlockId.value ? board.getBlock(configuredBlockId.value) : undefined,
)

// On open: ensure we know the connection + which repos the App can access, and
// the workspace's already-tracked repos (to flag ones already on the board).
// Declared after every ref resetSelection() touches so the `immediate` run
// doesn't access them inside their temporal dead zone.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    resetSelection()
    void loadRepos()
  },
  { immediate: true },
)

// A monorepo service needs a chosen directory; a whole-repo service can be added once.
const canAdd = computed(
  () =>
    !needsGitHub.value &&
    selectedRepoId.value !== undefined &&
    (isMonorepo.value ? !!selectedDirectory.value : !configuredBlockId.value),
)

async function add() {
  if (!canAdd.value || selectedRepoId.value === undefined) return
  adding.value = true
  try {
    const block = await board.addServiceFromRepo(selectedRepoId.value, {
      directory: isMonorepo.value ? selectedDirectory.value : undefined,
      isMonorepo: isMonorepo.value,
    })
    // Refresh the projection so the new repo↔block link is reflected locally.
    await github.load()
    configuredBlockId.value = block.id
    configuredDirectory.value = isMonorepo.value ? selectedDirectory.value : undefined
    toast.add({
      title: t('github.addService.toast.addedTitle'),
      description: t('github.addService.toast.addedDescription', { title: block.title }),
      icon: 'i-lucide-check',
      color: 'success',
    })
    // Ready to pick another monorepo service (the just-added directory is taken).
    selectedDirectory.value = undefined
  } catch (e) {
    toast.add({
      title: t('github.addService.toast.addFailedTitle'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    adding.value = false
  }
}

function done() {
  ui.closeAddService()
}
</script>

<template>
  <UModal v-model:open="open" :title="t('github.addService.title')" :ui="{ content: 'max-w-xl' }">
    <template #body>
      <div class="space-y-6">
        <p class="text-sm text-slate-400">
          {{ t('github.addService.intro') }}
        </p>

        <!-- not connected: linking a repo needs the App bound to this workspace -->
        <div
          v-if="needsGitHub"
          class="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
        >
          <div class="flex items-start gap-2">
            <UIcon name="i-lucide-plug-zap" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p class="text-sm text-amber-200/90">
              {{ t('github.addService.connectFirst') }}
            </p>
          </div>
          <GitHubConnect />
        </div>

        <template v-else>
          <UFormField
            :label="t('github.addService.repository')"
            :description="t('github.addService.repositoryHint')"
            required
          >
            <div v-if="!hasRepos" class="text-sm text-slate-400">
              {{ t('github.addService.noReposAvailable') }}
            </div>
            <div v-else class="space-y-1.5">
              <UInput
                v-model="repoSearch"
                icon="i-lucide-search"
                :placeholder="t('github.addService.filterPlaceholder')"
                class="w-full"
                :ui="{ trailing: 'pe-1' }"
              >
                <template v-if="repoSearch" #trailing>
                  <UButton
                    color="neutral"
                    variant="link"
                    size="sm"
                    icon="i-lucide-x"
                    :aria-label="t('github.addService.clearFilter')"
                    @click="repoSearch = ''"
                  />
                </template>
              </UInput>
              <USelect
                v-model="selectedRepoId"
                :items="filteredRepoItems"
                :placeholder="t('github.addService.chooseRepository')"
                class="w-full"
              />
              <p class="text-xs text-slate-500">
                {{
                  t('github.addService.showingCount', {
                    shown: filteredRepoItems.length,
                    total: repoItems.length,
                  })
                }}
              </p>
            </div>
          </UFormField>

          <!-- monorepo handling: flag + directory picker -->
          <div v-if="selectedRepoId !== undefined" class="space-y-3">
            <USwitch
              :model-value="isMonorepo"
              :label="t('github.addService.monorepoLabel')"
              :description="t('github.addService.monorepoDescription')"
              @update:model-value="toggleMonorepo"
            />

            <div
              v-if="isMonorepo"
              class="rounded-md border border-slate-700/60 bg-slate-900/40 p-3"
            >
              <p class="mb-2 text-xs text-slate-400">
                {{ t('github.addService.monorepoBrowseHint') }}
              </p>
              <RepoTreeBrowser
                v-model="selectedDirectory"
                :repo-github-id="selectedRepoId!"
                mode="dir"
              />
              <p class="mt-2 truncate text-xs text-slate-400">
                <template v-if="selectedDirectory">
                  {{ t('github.addService.serviceDirectory') }}
                  <code class="text-slate-200">{{ selectedDirectory }}</code>
                </template>
                <template v-else>{{ t('github.addService.noDirectorySelected') }}</template>
              </p>
            </div>
          </div>

          <!-- just-added service: configure it with the same controls as the inspector -->
          <div
            v-if="configuredBlock"
            class="space-y-4 rounded-md border border-emerald-900/50 bg-emerald-950/20 p-3"
          >
            <div
              class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-400"
            >
              <UIcon name="i-lucide-check" class="h-3.5 w-3.5" />
              {{ t('github.addService.addedConfigure', { title: configuredBlock.title }) }}
            </div>
            <ServiceTestConfig
              :block="configuredBlock"
              :repo="{ githubId: selectedRepoId!, directory: configuredDirectory }"
            />
            <ServiceFragments :block="configuredBlock" />
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <UButton
              v-if="manageInstallUrl"
              color="neutral"
              variant="subtle"
              size="sm"
              icon="i-lucide-shield-check"
              trailing-icon="i-lucide-external-link"
              :title="t('github.addService.grantAccessTitle')"
              @click="openManageInstall"
            >
              {{ t('github.addService.grantAccess') }}
            </UButton>
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-refresh-cw"
              :loading="github.loadingAvailable"
              @click="github.loadAvailableRepos()"
            >
              {{ t('github.addService.refreshList') }}
            </UButton>
          </div>

          <div class="flex justify-end gap-2">
            <UButton v-if="configuredBlock" color="neutral" variant="soft" size="sm" @click="done">
              {{ t('github.addService.done') }}
            </UButton>
            <UButton
              v-if="!configuredBlock || isMonorepo"
              color="primary"
              icon="i-lucide-plus"
              :loading="adding"
              :disabled="!canAdd"
              @click="add"
            >
              {{
                configuredBlock && isMonorepo
                  ? t('github.addService.addAnother')
                  : t('github.addService.add')
              }}
            </UButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
