<script setup lang="ts">
// Add a board service backed by an EXISTING GitHub repository — no bootstrap
// run. Unlike the bootstrap modal (which creates a repo and has an agent adapt
// it in a container), this just links a repo the App can access to a fresh,
// `ready` service frame. The workspace need not track the repo yet: the backend
// links + syncs it on import. If the App can't see the wanted repo, the user
// grants it access from here, then searches for it again.
//
// MONOREPO support: a repo flagged a monorepo can back SEVERAL services, each
// pinned to a subdirectory. When the selected repo is a monorepo, the user
// browses its tree and multi-selects the service directories to add — from ANY
// parent folder, in one pass — then adds them all at once. Directories that
// already back a service on this board are shown but not selectable.
import type { FrameRepoType, GitHubAvailableRepo } from '~/types/domain'
import GitHubConnect from '~/components/github/GitHubConnect.vue'
import RepoSearchEmpty from '~/components/github/RepoSearchEmpty.vue'
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'
import ServiceTestConfig from '~/components/panels/inspector/ServiceTestConfig.vue'
import ServiceFragments from '~/components/panels/inspector/ServiceFragments.vue'

const { t } = useI18n()

// The behavioural repo role for the imported frame. `service` (backend) is the default so
// existing muscle memory is unchanged; the options are the four onboardable roles (shared
// with the bootstrap modal via useFrameRepoTypeItems).
const selectedType = ref<FrameRepoType>('service')
const typeItems = useFrameRepoTypeItems()
const ui = useUiStore()
const github = useGitHubStore()
const board = useBoardStore()
const services = useServicesStore()
const toast = useToast()
const { freeFramePosition, focusFrame } = useFramePlacement()

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
    // Load only the linked-repo projection (to flag repos already on the board). The
    // available-repos list is NOT prefetched — it's searched server-side on demand once
    // the user types (see the repoQueryRaw watcher), so a wide install isn't shipped whole.
    if (github.connected) await github.load()
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

// Repos whose service is ALREADY mounted on THIS board can't be added again — adding here would
// be a no-op. A repo whose service lives on ANOTHER board in the org stays addable: adding it
// MOUNTS the shared service onto this board (backend `addServiceFromRepo`). Monorepos are exempt
// (each subdirectory is its own service). Derived from the account's catalog cross-referenced with
// this board's mounts (`byServiceId`), since the repo projection carries no repo→block link.
const onBoardIds = computed(
  () =>
    new Set(
      services.catalog
        .filter((s) => services.byServiceId[s.id])
        .map((s) => s.repoGithubId)
        .filter((id): id is number => id != null),
    ),
)

// Map an available repo to a combobox item. The label carries the private/monorepo/
// on-board suffixes; an on-board whole-repo is disabled (it already backs a service).
function toRepoItem(r: GitHubAvailableRepo) {
  const onBoard = onBoardIds.value.has(r.githubId) && !r.isMonorepo
  const suffix = [
    r.private ? t('github.addService.repoLabel.private') : '',
    r.isMonorepo ? t('github.addService.repoLabel.monorepo') : '',
    // Reachable only via the signed-in user's PAT (not the workspace App) — its frame is
    // hidden from members without their own access.
    r.personal ? t('github.addService.repoLabel.personal') : '',
    onBoard ? t('github.addService.repoLabel.onBoard') : '',
  ].join('')
  return { label: `${r.owner}/${r.name}${suffix}`, value: r.githubId, disabled: onBoard }
}

// Server-side, debounced, min-length-gated repo search (a wide App install / PAT can expose
// hundreds of repos, too many to prefetch and filter in the browser). Shared with the doc-task
// reference-repo picker via `useRepoSearch`; `repoResults` is this picker's own result list, so
// the two never clobber each other. Nothing is fetched on open — the field prompts for more
// characters below the gate; granting the App access needs no manual refresh (the next search
// hits GitHub live).
const {
  search: repoSearch,
  query: repoQueryRaw,
  belowMinChars,
  results: repoResults,
  loading: repoLoading,
  reset: resetRepoSearch,
} = useRepoSearch()

const repoItems = computed(() => repoResults.value.map(toRepoItem))

// The selected repo, captured when picked (below). The loaded list is volatile — a later
// search replaces it — so the selection can't be derived from the results after the fact.
const selectedRepo = ref<GitHubAvailableRepo | undefined>(undefined)

// The server already filtered, so the matches ARE the loaded repos (empty below the gate).
const queryMatches = computed(() => (belowMinChars.value ? [] : repoItems.value))

// Items fed to the combobox: the matches plus the current selection kept present, so the
// menu still renders the selected repo's label after a later search replaces the list.
const repoMenuItems = computed(() => {
  const matches = queryMatches.value
  if (selectedRepoId.value === undefined) return matches
  if (matches.some((r) => r.value === selectedRepoId.value)) return matches
  return selectedRepo.value ? [toRepoItem(selectedRepo.value), ...matches] : matches
})

// ---- monorepo flag + directory picker ------------------------------------

// The monorepo flag is MODAL-LOCAL state, sent as part of the add-service request
// rather than persisted up-front on a toggle: there's no need to round-trip a PATCH
// before adding (browsing the tree needs only the repo id, and the backend flags the
// repo + requires a directory when it creates the service). A repo already flagged a
// monorepo (it backs other services) seeds the toggle on when selected.
const isMonorepo = ref(false)
// The cart of monorepo service directories the user has picked (repo-root-relative),
// accumulated across the whole browse session so picks from different parent folders
// coexist. Added all at once (see `addServices`), unlike the one-at-a-time whole-repo add.
const selectedDirectories = ref<string[]>([])

// Directories in the selected repo that ALREADY back a service on this board — surfaced
// so the tree browser can disable them (adding one again would be a no-op). Derived from
// the org catalog filtered to this repo; a whole-repo service (null directory) is ignored.
const addedDirectories = computed<string[]>(() => {
  if (selectedRepoId.value === undefined) return []
  return services.catalog
    .filter((s) => s.repoGithubId === selectedRepoId.value && s.directory)
    .map((s) => normalizeDir(s.directory as string))
})
const addedDirSet = computed(() => new Set(addedDirectories.value))

function normalizeDir(p: string): string {
  return p.replace(/^\/+|\/+$/g, '')
}

function toggleMonorepo(value: boolean) {
  isMonorepo.value = value
  selectedDirectories.value = []
}

// Add/remove a directory from the cart. Guards against an already-added directory (the
// browser disables it, but keep the model authoritative).
function toggleDirectory(path: string) {
  if (addedDirSet.value.has(normalizeDir(path))) return
  const i = selectedDirectories.value.indexOf(path)
  if (i >= 0) selectedDirectories.value.splice(i, 1)
  else selectedDirectories.value.push(path)
}

function removeSelected(path: string) {
  const i = selectedDirectories.value.indexOf(path)
  if (i >= 0) selectedDirectories.value.splice(i, 1)
}

// On repo change, capture the picked repo (from the volatile loaded list, before a later
// search replaces it), seed the monorepo toggle from its persisted flag, and clear the rest.
watch(selectedRepoId, (id) => {
  if (id === undefined) selectedRepo.value = undefined
  else {
    const found = repoResults.value.find((r) => r.githubId === id)
    if (found) selectedRepo.value = found
  }
  isMonorepo.value = selectedRepo.value?.isMonorepo === true
  selectedDirectories.value = []
  configuredBlockId.value = undefined
})

function resetSelection() {
  selectedRepoId.value = undefined
  selectedDirectories.value = []
  isMonorepo.value = false
  configuredBlockId.value = undefined
  resetRepoSearch()
  selectedType.value = 'service'
}

// Clear the current repo selection (the combobox's trailing ✕) so the user can pick a
// different one — drops the selection-dependent state and resets the search term. The
// combobox has no built-in deselect, so the field would otherwise stay pinned to a repo.
function clearSelection() {
  resetSelection()
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

// The just-added whole-repo service, kept on the board store so the user can configure it
// (test infra + fragments) right here — the same controls as the inspector. Only the
// whole-repo flow surfaces this inline configure step; a monorepo adds several services at
// once and they're configured later in the inspector.
const configuredBlockId = ref<string | undefined>(undefined)
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

// A whole-repo service is added once (then configured inline). A monorepo instead
// multi-selects directories and adds them together via `addServices`.
const canAdd = computed(
  () =>
    !needsGitHub.value &&
    selectedRepoId.value !== undefined &&
    !isMonorepo.value &&
    !configuredBlockId.value,
)
const canAddServices = computed(
  () =>
    !needsGitHub.value &&
    selectedRepoId.value !== undefined &&
    isMonorepo.value &&
    selectedDirectories.value.length > 0,
)

async function add() {
  if (!canAdd.value || selectedRepoId.value === undefined) return
  adding.value = true
  try {
    const block = await board.addServiceFromRepo(selectedRepoId.value, {
      type: selectedType.value,
      // Place the imported frame in free space (centred in view) instead of the
      // backend's default stagger, so it never overlaps an existing service.
      position: freeFramePosition(),
    })
    // Refresh the projection so the new repo↔block link is reflected locally.
    await github.load()
    // Centre the camera on the newly imported service.
    await focusFrame(block.id)
    configuredBlockId.value = block.id
    toast.add({
      title: t('github.addService.toast.addedTitle'),
      description: t('github.addService.toast.addedDescription', { title: block.title }),
      icon: 'i-lucide-check',
      color: 'success',
    })
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

// Add every directory in the cart as its own service, in one action. Each add lays the
// frame out in free space (seeing the ones added earlier in the loop, so they don't
// overlap); the projection is refreshed and the camera centres on the last one. The
// just-added directories then move to `addedDirectories`, so the cart is cleared and the
// tree marks them "added" — ready to pick more (from any folder) or close.
async function addServices() {
  if (!canAddServices.value || selectedRepoId.value === undefined) return
  const dirs = selectedDirectories.value.filter((d) => !addedDirSet.value.has(normalizeDir(d)))
  if (dirs.length === 0) return
  adding.value = true
  try {
    let lastBlock: Awaited<ReturnType<typeof board.addServiceFromRepo>> | undefined
    for (const directory of dirs) {
      lastBlock = await board.addServiceFromRepo(selectedRepoId.value, {
        directory,
        isMonorepo: true,
        type: selectedType.value,
        position: freeFramePosition(),
      })
    }
    await github.load()
    if (lastBlock) await focusFrame(lastBlock.id)
    selectedDirectories.value = []
    toast.add({
      title: t('github.addService.toast.servicesAddedTitle'),
      description: t(
        'github.addService.toast.servicesAddedDescription',
        { count: dirs.length },
        dirs.length,
      ),
      icon: 'i-lucide-check',
      color: 'success',
    })
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
            <div class="space-y-1.5">
              <UInputMenu
                v-model="selectedRepoId"
                v-model:search-term="repoSearch"
                :items="repoMenuItems"
                :ignore-filter="true"
                value-key="value"
                :loading="repoLoading"
                icon="i-lucide-search"
                :placeholder="t('github.addService.searchPlaceholder')"
                class="w-full"
              >
                <template v-if="selectedRepoId !== undefined" #trailing>
                  <UButton
                    color="neutral"
                    variant="link"
                    size="sm"
                    icon="i-lucide-x"
                    :aria-label="t('github.addService.clearSelection')"
                    @click.stop="clearSelection"
                  />
                </template>
                <template #empty>
                  <RepoSearchEmpty
                    :below-min-chars="belowMinChars"
                    :loading="repoLoading"
                    :query="repoQueryRaw"
                  />
                </template>
              </UInputMenu>
            </div>
          </UFormField>

          <UFormField
            :label="t('github.addService.repoType')"
            :description="t('github.addService.repoTypeHint')"
          >
            <USelect v-model="selectedType" :items="typeItems" value-key="value" class="w-full" />
          </UFormField>

          <!-- monorepo handling: flag + multi-directory picker (hidden once a whole-repo
               service has been added and is being configured inline) -->
          <div v-if="selectedRepoId !== undefined && !configuredBlock" class="space-y-3">
            <USwitch
              :model-value="isMonorepo"
              :label="t('github.addService.monorepoLabel')"
              :description="t('github.addService.monorepoDescription')"
              @update:model-value="toggleMonorepo"
            />

            <div
              v-if="isMonorepo"
              class="space-y-3 rounded-md border border-slate-700/60 bg-slate-900/40 p-3"
            >
              <p class="text-xs text-slate-400">
                {{ t('github.addService.monorepoBrowseHint') }}
              </p>
              <RepoTreeBrowser
                :repo-github-id="selectedRepoId!"
                mode="dir"
                multiple
                :selected-paths="selectedDirectories"
                :added-paths="addedDirectories"
                @toggle="toggleDirectory"
              />

              <!-- the selection cart + the add action sit right beside the tree, so the
                   picked services and the button that adds them are never scrolled apart -->
              <div class="space-y-2 rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
                <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {{ t('github.addService.selectedServices') }}
                </p>
                <div v-if="selectedDirectories.length" class="flex flex-wrap gap-1.5">
                  <span
                    v-for="dir in selectedDirectories"
                    :key="dir"
                    class="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-200"
                  >
                    <code class="text-slate-200">{{ dir }}</code>
                    <button
                      type="button"
                      class="text-slate-400 hover:text-slate-100"
                      :aria-label="t('github.addService.removeService', { directory: dir })"
                      @click="removeSelected(dir)"
                    >
                      <UIcon name="i-lucide-x" class="h-3 w-3" />
                    </button>
                  </span>
                </div>
                <p v-else class="text-xs text-slate-500">
                  {{ t('github.addService.noServicesSelected') }}
                </p>
                <div class="flex justify-end">
                  <UButton
                    color="primary"
                    icon="i-lucide-plus"
                    size="sm"
                    :loading="adding"
                    :disabled="!canAddServices"
                    @click="addServices"
                  >
                    {{
                      t(
                        'github.addService.addServices',
                        { count: selectedDirectories.length },
                        selectedDirectories.length,
                      )
                    }}
                  </UButton>
                </div>
              </div>
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
              :repo="{ githubId: selectedRepoId! }"
              default-open
            />
            <ServiceFragments :block="configuredBlock" default-open />
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
          </div>

          <div class="flex justify-end gap-2">
            <!-- Monorepo adds via the cart's own button; the footer only closes. A
                 whole-repo add shows its "Add service" button until one is added, then
                 the inline configure panel + this Done. -->
            <UButton
              v-if="configuredBlock || isMonorepo"
              color="neutral"
              variant="soft"
              size="sm"
              @click="done"
            >
              {{ t('github.addService.done') }}
            </UButton>
            <UButton
              v-if="!isMonorepo && !configuredBlock"
              color="primary"
              icon="i-lucide-plus"
              :loading="adding"
              :disabled="!canAdd"
              @click="add"
            >
              {{ t('github.addService.add') }}
            </UButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
