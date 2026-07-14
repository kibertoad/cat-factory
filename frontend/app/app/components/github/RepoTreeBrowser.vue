<script setup lang="ts">
// A reusable GitHub repo tree browser: lists one level of a repo at a time
// (breadcrumb-navigable) and lets the user PICK a path. Two modes:
//   - `dir`  — pick a subdirectory (the monorepo service-directory picker), and
//   - `file` — pick a file (the service docker-compose location picker).
// The selected path (relative to the repo root, as GitHub returns it) is exposed
// via `v-model`. The component owns its own navigation/loading state so callers
// just bind a repo id + mode; it self-loads on mount and when those change.
//
// `dir` mode additionally supports `multiple`: instead of the single `v-model`
// path, the caller passes the current `selectedPaths` (a cart) + `addedPaths`
// (directories already on the board, shown disabled) and handles the `toggle`
// event to add/remove a directory. This lets one browse session accumulate
// several services from ANY parent folder (the monorepo add flow) — navigating
// away never drops earlier picks.
import type { RepoTreeEntry } from '~/types/domain'

const props = withDefaults(
  defineProps<{
    repoGithubId: number
    mode?: 'dir' | 'file'
    /** Currently picked path (repo-root-relative), via v-model. Single-select only. */
    modelValue?: string
    /** Directory to open at (e.g. a monorepo service's subdirectory). */
    startPath?: string
    /** `dir` mode: accumulate a set of picks (via `selectedPaths`/`toggle`) instead of one. */
    multiple?: boolean
    /** `dir` + `multiple`: the current cart of picked directories (repo-root-relative). */
    selectedPaths?: string[]
    /** `dir` + `multiple`: directories already on the board — listed but not selectable. */
    addedPaths?: string[]
  }>(),
  { mode: 'dir', startPath: '', multiple: false, selectedPaths: () => [], addedPaths: () => [] },
)
const emit = defineEmits<{
  'update:modelValue': [string | undefined]
  /** `dir` + `multiple`: the user asked to add/remove this directory from the cart. */
  toggle: [string]
}>()

const { t } = useI18n()
const github = useGitHubStore()
const toast = useToast()

const currentPath = ref(props.startPath)
const treeEntries = ref<RepoTreeEntry[]>([])
const loading = ref(false)

/** Repo-root-relative paths carry no surrounding slashes; normalise so a stored
 *  service `directory` (which may) compares equal to a tree entry's `path`. */
function normalizePath(p: string): string {
  return p.replace(/^\/+|\/+$/g, '')
}
const selectedSet = computed(() => new Set(props.selectedPaths.map(normalizePath)))
const addedSet = computed(() => new Set(props.addedPaths.map(normalizePath)))
function isAdded(path: string): boolean {
  return props.multiple && addedSet.value.has(normalizePath(path))
}
function isPicked(path: string): boolean {
  return props.multiple ? selectedSet.value.has(normalizePath(path)) : props.modelValue === path
}

const dirEntries = computed(() => treeEntries.value.filter((e) => e.type === 'dir'))
const fileEntries = computed(() => treeEntries.value.filter((e) => e.type === 'file'))
const isEmpty = computed(() =>
  props.mode === 'dir' ? dirEntries.value.length === 0 : treeEntries.value.length === 0,
)

const breadcrumbs = computed(() => {
  const segments = currentPath.value ? currentPath.value.split('/') : []
  let acc = ''
  return segments.map((seg) => {
    acc = acc ? `${acc}/${seg}` : seg
    return { label: seg, path: acc }
  })
})

async function browseTo(path: string) {
  loading.value = true
  try {
    currentPath.value = path
    treeEntries.value = await github.loadRepoTree(props.repoGithubId, path)
  } catch (e) {
    treeEntries.value = []
    toast.add({
      title: t('github.repoTree.errors.listDirectory'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    loading.value = false
  }
}

function pick(path: string) {
  if (props.multiple) {
    // Already-on-board directories are shown for orientation but can't be re-added.
    if (addedSet.value.has(normalizePath(path))) return
    emit('toggle', path)
  } else {
    emit('update:modelValue', path)
  }
}

// Re-open at the start path whenever the repo (or requested root) changes.
watch(
  () => [props.repoGithubId, props.startPath] as const,
  () => void browseTo(props.startPath ?? ''),
  { immediate: true },
)
</script>

<template>
  <div>
    <!-- breadcrumbs -->
    <div class="mb-2 flex flex-wrap items-center gap-1 text-sm">
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-folder-tree"
        :disabled="loading"
        @click="browseTo('')"
      >
        {{ t('github.repoTree.root') }}
      </UButton>
      <template v-for="crumb in breadcrumbs" :key="crumb.path">
        <span class="text-slate-600">/</span>
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          :disabled="loading"
          @click="browseTo(crumb.path)"
        >
          {{ crumb.label }}
        </UButton>
      </template>
    </div>

    <!-- listing -->
    <div class="max-h-56 overflow-auto rounded border border-slate-800">
      <div v-if="loading" class="p-3 text-sm text-slate-400">
        {{ t('github.repoTree.loading') }}
      </div>
      <div v-else-if="isEmpty" class="p-3 text-sm text-slate-400">
        {{ mode === 'dir' ? t('github.repoTree.noSubdirectories') : t('github.repoTree.empty') }}
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
          <span
            v-if="mode === 'dir' && isAdded(entry.path)"
            class="flex shrink-0 items-center gap-1 text-xs text-slate-500"
          >
            <UIcon name="i-lucide-check" class="h-3.5 w-3.5" />
            {{ t('github.repoTree.added') }}
          </span>
          <UButton
            v-else-if="mode === 'dir'"
            size="xs"
            variant="soft"
            :color="isPicked(entry.path) ? 'primary' : 'neutral'"
            @click="pick(entry.path)"
          >
            {{ isPicked(entry.path) ? t('github.repoTree.selected') : t('github.repoTree.select') }}
          </UButton>
        </li>
        <template v-if="mode === 'file'">
          <li
            v-for="entry in fileEntries"
            :key="entry.path"
            class="flex items-center justify-between gap-2 px-3 py-1.5"
          >
            <button
              type="button"
              class="flex items-center gap-2 truncate text-sm hover:text-primary-400"
              :class="modelValue === entry.path ? 'text-primary-400' : 'text-slate-300'"
              @click="pick(entry.path)"
            >
              <UIcon name="i-lucide-file" class="h-4 w-4 shrink-0 text-slate-400" />
              <span class="truncate">{{ entry.name }}</span>
            </button>
            <UIcon
              v-if="modelValue === entry.path"
              name="i-lucide-check"
              class="h-4 w-4 shrink-0 text-primary-400"
            />
          </li>
        </template>
      </ul>
    </div>

    <!-- dir mode: pin the current folder without descending into a child -->
    <div
      v-if="mode === 'dir' && currentPath && !isAdded(currentPath)"
      class="mt-2 flex justify-end"
    >
      <UButton
        size="xs"
        variant="soft"
        :color="isPicked(currentPath) ? 'primary' : 'neutral'"
        @click="pick(currentPath)"
      >
        {{
          multiple && isPicked(currentPath)
            ? t('github.repoTree.selected')
            : t('github.repoTree.useThisFolder')
        }}
      </UButton>
    </div>
  </div>
</template>
