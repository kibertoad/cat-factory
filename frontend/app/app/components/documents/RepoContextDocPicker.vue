<script setup lang="ts">
// Repo-backed context-document picker: the GitHub / GitLab branch of
// ContextDocumentPicker. A repo-doc reference is a single file in a repository the
// workspace's App (or PAT) can reach, so instead of the generic free-text search
// this flow is: pick a repository, then pick one or more FILES from it — either by
// searching the whole tree by path, or by browsing it with the same tree browser the
// monorepo add-service flow uses. Each picked file is STAGED (emitted as a
// `PendingContext`, imported + linked once the block exists); already-staged files
// are shown "added" and can't be re-picked, mirroring the other context pickers.
//
// The repo search reuses `useRepoSearch` (debounce + stale-guard + per-instance
// results, so it never clobbers another picker's list) and the file search reuses the
// github store's recursive-tree cache (`loadRepoFiles`) so filtering is instant and
// client-side after one fetch per repo. Nothing here is GitHub-specific beyond the
// store it rides: the same store transparently returns GitLab projects via the VCS
// adapter, so this works unchanged on a GitLab deployment.
import type { DocumentSourceKind, GitHubAvailableRepo, RepoTreeEntry } from '~/types/domain'
import EmptyState from '~/components/common/EmptyState.vue'
import RepoSearchEmpty from '~/components/github/RepoSearchEmpty.vue'
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'

const props = defineProps<{
  /** The repo-backed document source (`github`) whose files are being attached. */
  source: DocumentSourceKind
  /** Lucide icon for the source, used on each staged file row. */
  icon: string
  /** contextKeys already staged by the caller, so they're shown "added" / not re-offered. */
  chosenKeys?: string[]
}>()
const emit = defineEmits<{ pick: [item: PendingContext] }>()

const { t } = useI18n()
const github = useGitHubStore()

const chosen = computed(() => new Set(props.chosenKeys ?? []))

// ---- repo search (reused pattern) ----------------------------------------
const {
  search: repoSearch,
  query: repoQueryRaw,
  belowMinChars,
  results: repoResults,
  loading: repoLoading,
  reset: resetRepoSearch,
} = useRepoSearch()

const selectedRepoId = ref<number | undefined>(undefined)
// Captured when picked — the results list is volatile (a later search replaces it), so
// the owner/name can't be recovered from it after the fact, and we need them to build
// the `owner/repo:path` external id.
const selectedRepo = ref<GitHubAvailableRepo | undefined>(undefined)

function toRepoItem(r: GitHubAvailableRepo) {
  const suffix = r.private ? t('github.addService.repoLabel.private') : ''
  return { label: `${r.owner}/${r.name}${suffix}`, value: r.githubId }
}
const queryMatches = computed(() => (belowMinChars.value ? [] : repoResults.value.map(toRepoItem)))
const repoMenuItems = computed(() => {
  const matches = queryMatches.value
  if (selectedRepoId.value === undefined) return matches
  if (matches.some((r) => r.value === selectedRepoId.value)) return matches
  return selectedRepo.value ? [toRepoItem(selectedRepo.value), ...matches] : matches
})

watch(selectedRepoId, (id) => {
  if (id === undefined) {
    selectedRepo.value = undefined
    return
  }
  const found = repoResults.value.find((r) => r.githubId === id)
  if (found) selectedRepo.value = found
})

function clearRepo() {
  selectedRepoId.value = undefined
  selectedRepo.value = undefined
  resetRepoSearch()
  fileQuery.value = ''
}

// ---- file selection (browse | search) ------------------------------------
type FileMode = 'search' | 'browse'
const fileMode = ref<FileMode>('search')

// Files already staged for THIS repo, as repo-root-relative paths — derived from the
// caller's chosen keys (`document:<source>:<owner>/<repo>:<path>`). Shown disabled in
// both the tree browser and the search list so a file can't be staged twice.
const addedPaths = computed<string[]>(() => {
  const repo = selectedRepo.value
  if (!repo) return []
  const prefix = `document:${props.source}:${repo.owner}/${repo.name}:`
  return [...chosen.value].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
})
const addedSet = computed(() => new Set(addedPaths.value.map(normalizeRepoPath)))

// The recursive file listing for the selected repo, loaded + cached on demand for the
// search box. Loaded lazily when the user first switches to / lands on search.
const files = computed<RepoTreeEntry[]>(() =>
  selectedRepoId.value !== undefined ? (github.repoFiles[selectedRepoId.value] ?? []) : [],
)
const loadingFiles = ref(false)
const filesError = ref<string | null>(null)

async function ensureFilesLoaded() {
  if (selectedRepoId.value === undefined) return
  if (github.repoFiles[selectedRepoId.value]) return
  loadingFiles.value = true
  filesError.value = null
  try {
    await github.loadRepoFiles(selectedRepoId.value)
  } catch (e) {
    filesError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingFiles.value = false
  }
}

// Load the file list as soon as a repo is picked (search is the default tab); browsing
// uses the per-level tree endpoint and needs no preload.
watch(selectedRepoId, (id) => {
  fileQuery.value = ''
  fileMode.value = 'search'
  if (id !== undefined) void ensureFilesLoaded()
})

const fileQuery = ref('')
// Matches are computed client-side from the cached tree (no per-keystroke server call).
// A query is required so a large repo never renders thousands of rows at once; results
// are capped for the same reason.
const FILE_RESULTS_CAP = 50
// Filter the cached tree ONCE per keystroke, then derive the capped view + the
// "truncated" flag from that single pass (a large monorepo tree is filtered twice
// otherwise, once per computed, on every keystroke).
const fileMatchesAll = computed(() => {
  const q = fileQuery.value.trim().toLowerCase()
  if (!q) return []
  return files.value.filter(
    (f) => !addedSet.value.has(normalizeRepoPath(f.path)) && f.path.toLowerCase().includes(q),
  )
})
const fileMatches = computed(() => fileMatchesAll.value.slice(0, FILE_RESULTS_CAP))
const fileMatchesTruncated = computed(() => fileMatchesAll.value.length > FILE_RESULTS_CAP)

function pickFile(path: string) {
  const repo = selectedRepo.value
  if (!repo || addedSet.value.has(normalizeRepoPath(path))) return
  const clean = normalizeRepoPath(path)
  emit('pick', {
    kind: 'document',
    source: props.source,
    // The GitHub/GitLab doc source's canonical `owner/repo:path` external id.
    externalId: `${repo.owner}/${repo.name}:${clean}`,
    title: clean.split('/').pop() || clean,
    subtitle: `${repo.owner}/${repo.name} · ${clean}`,
    icon: props.icon,
    needsImport: true,
  })
}

onMounted(() => {
  // The repo search rides the github store; make sure the App connection is probed so
  // `searchAvailableRepos` sees `connected` (single-flighted — cheap to call).
  github.ensureProbed().catch(() => {})
})
</script>

<template>
  <div class="space-y-2">
    <!-- 1. pick a repository -->
    <UInputMenu
      v-model="selectedRepoId"
      v-model:search-term="repoSearch"
      :items="repoMenuItems"
      :ignore-filter="true"
      value-key="value"
      :loading="repoLoading"
      icon="i-lucide-search"
      size="sm"
      :placeholder="t('documents.repoPicker.searchRepoPlaceholder')"
      class="w-full"
    >
      <template v-if="selectedRepoId !== undefined" #trailing>
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          icon="i-lucide-x"
          :aria-label="t('documents.repoPicker.clearRepo')"
          @click.stop="clearRepo"
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

    <!-- 2. pick file(s) from the chosen repo -->
    <template v-if="selectedRepoId !== undefined">
      <div class="flex items-center gap-1">
        <UButton
          size="xs"
          :color="fileMode === 'search' ? 'primary' : 'neutral'"
          :variant="fileMode === 'search' ? 'soft' : 'ghost'"
          icon="i-lucide-search"
          @click="fileMode = 'search'"
        >
          {{ t('documents.repoPicker.searchTab') }}
        </UButton>
        <UButton
          size="xs"
          :color="fileMode === 'browse' ? 'primary' : 'neutral'"
          :variant="fileMode === 'browse' ? 'soft' : 'ghost'"
          icon="i-lucide-folder-tree"
          @click="fileMode = 'browse'"
        >
          {{ t('documents.repoPicker.browseTab') }}
        </UButton>
      </div>

      <!-- search files by path (client-side over the cached recursive tree) -->
      <div v-if="fileMode === 'search'" class="space-y-2">
        <UInput
          v-model="fileQuery"
          :icon="loadingFiles ? 'i-lucide-loader-circle' : 'i-lucide-file-search'"
          :ui="{ leadingIcon: loadingFiles ? 'animate-spin' : '' }"
          size="sm"
          class="w-full"
          :placeholder="t('documents.repoPicker.searchFilesPlaceholder')"
        />
        <p v-if="filesError" class="px-1 text-[11px] text-amber-400">
          {{ t('documents.repoPicker.filesFailed', { error: filesError }) }}
        </p>
        <div class="max-h-56 space-y-0.5 overflow-y-auto">
          <button
            v-for="f in fileMatches"
            :key="f.path"
            type="button"
            class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs text-slate-300 hover:bg-slate-800/70"
            @click="pickFile(f.path)"
          >
            <UIcon :name="icon" class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
            <span class="truncate">{{ f.path }}</span>
          </button>
          <p v-if="fileMatchesTruncated" class="px-2 py-1 text-[11px] text-slate-500">
            {{ t('documents.repoPicker.moreFiles', { count: FILE_RESULTS_CAP }) }}
          </p>
          <EmptyState
            v-if="!loadingFiles && !filesError && fileQuery.trim() && fileMatches.length === 0"
            compact
            icon="i-lucide-file-search"
            :title="t('documents.repoPicker.noFileMatches')"
          />
          <p
            v-else-if="!loadingFiles && !fileQuery.trim()"
            class="px-2 py-1 text-[11px] text-slate-500"
          >
            {{ t('documents.repoPicker.searchFilesHint') }}
          </p>
        </div>
      </div>

      <!-- browse the tree, multi-pick files (same browser as the monorepo flow) -->
      <RepoTreeBrowser
        v-else
        :repo-github-id="selectedRepoId"
        mode="file"
        multiple
        :added-paths="addedPaths"
        @toggle="pickFile"
      />
    </template>
  </div>
</template>
