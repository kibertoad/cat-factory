<script setup lang="ts">
// A reusable GitHub repo tree browser: lists one level of a repo at a time
// (breadcrumb-navigable) and lets the user PICK a path. Two modes:
//   - `dir`  — pick a subdirectory (the monorepo service-directory picker), and
//   - `file` — pick a file (the service docker-compose location picker).
// The selected path (relative to the repo root, as GitHub returns it) is exposed
// via `v-model`. The component owns its own navigation/loading state so callers
// just bind a repo id + mode; it self-loads on mount and when those change.
//
// Both modes additionally support `multiple`: instead of the single `v-model`
// path, the caller passes the current `selectedPaths` (a cart) + `addedPaths`
// (paths already chosen elsewhere, shown disabled) and handles the `toggle`
// event to add/remove a path. In `dir` mode this accumulates service directories
// from ANY parent folder (the monorepo add flow); in `file` mode it accumulates
// context-document files from anywhere in the tree — navigating away never drops
// earlier picks.
//
// `dir` mode also PLACES a directory that does not exist yet (`newDirName`: the bootstrap
// service-directory field). Nothing in the tree can be the target then, so the pick is the
// folder the caller is standing in and the emitted value is that folder plus the new name.
import type { RepoTreeEntry } from '~/types/domain'

const props = withDefaults(
  defineProps<{
    repoGithubId: number
    mode?: 'dir' | 'file'
    /** Currently picked path (repo-root-relative), via v-model. Single-select only. */
    modelValue?: string
    /** Directory to open at (e.g. a monorepo service's subdirectory). */
    startPath?: string
    /** Accumulate a set of picks (via `selectedPaths`/`toggle`) instead of one. Either mode. */
    multiple?: boolean
    /** `multiple`: the current cart of picked paths (repo-root-relative). */
    selectedPaths?: string[]
    /** `multiple`: paths already chosen elsewhere — listed but not selectable. */
    addedPaths?: string[]
    /**
     * `dir`, single-select: the name of a directory that DOES NOT EXIST YET, which this
     * browser is choosing a home for. Picking a folder then emits `<folder>/<newDirName>`
     * (the repo root included, so the footer is offered there too), and a listing that
     * already holds the name says so and offers nothing: "the target must not exist" is the
     * one half of the API's refusal the listing in front of the user can answer first.
     */
    newDirName?: string
  }>(),
  {
    mode: 'dir',
    startPath: '',
    multiple: false,
    selectedPaths: () => [],
    addedPaths: () => [],
    newDirName: '',
  },
)
const emit = defineEmits<{
  'update:modelValue': [string | undefined]
  /** `dir` + `multiple`: the user asked to add/remove this directory from the cart. */
  toggle: [string]
}>()

const { t } = useI18n()
const github = useGitHubStore()
const { present } = usePipelineErrorToast()

const currentPath = ref(props.startPath)
const treeEntries = ref<RepoTreeEntry[]>([])
const loading = ref(false)

const selectedSet = computed(() => new Set(props.selectedPaths.map(normalizeRepoPath)))
const addedSet = computed(() => new Set(props.addedPaths.map(normalizeRepoPath)))
// Placing a new directory is single-target by construction: a cart of not-yet-existing
// siblings has no caller, and the pick copy below reads as one target.
const placingNewDir = computed(() => props.mode === 'dir' && !props.multiple && !!props.newDirName)

/** What a pick on `folder` yields: the new directory's path, or the folder itself. */
function pickedPathFor(folder: string): string {
  return placingNewDir.value ? joinRepoPath(folder, props.newDirName) : folder
}

function isAdded(path: string): boolean {
  return props.multiple && addedSet.value.has(normalizeRepoPath(path))
}
function isPicked(path: string): boolean {
  if (props.multiple) return selectedSet.value.has(normalizeRepoPath(path))
  return normalizeRepoPath(props.modelValue ?? '') === normalizeRepoPath(pickedPathFor(path))
}

// The CURRENT listing already holds the name, so the new directory cannot go here. Only the
// folder the browser has actually LISTED can be judged: answering for a child would mean
// listing every one of them, so navigating in IS how you ask about a child. `loading` is part
// of that reading, because `browseTo` moves `currentPath` before its fetch settles and the
// entries still in hand are the folder the user has already left.
const nameTakenHere = computed(
  () =>
    placingNewDir.value &&
    !loading.value &&
    treeEntries.value.some((e) => e.name === props.newDirName),
)

/** The listed entry that IS the clash, flagged in place so the reason sits where the eye is. */
function clashes(entry: RepoTreeEntry): boolean {
  return placingNewDir.value && entry.name === props.newDirName
}

const dirEntries = computed(() => treeEntries.value.filter((e) => e.type === 'dir'))
const fileEntries = computed(() => treeEntries.value.filter((e) => e.type === 'file'))
const isEmpty = computed(() =>
  props.mode === 'dir' ? dirEntries.value.length === 0 : treeEntries.value.length === 0,
)

// file + multiple: the bulk-pick header. "Select all" checks every file of the CURRENT
// listing that isn't already picked or added elsewhere; unchecking clears only this
// listing's picks (never the cart entries staged from other folders).
const selectableFiles = computed(() =>
  props.mode === 'file' && props.multiple ? fileEntries.value.filter((e) => !isAdded(e.path)) : [],
)
const allSelected = computed(
  () => selectableFiles.value.length > 0 && selectableFiles.value.every((e) => isPicked(e.path)),
)
function toggleAllFiles() {
  const check = !allSelected.value
  for (const entry of selectableFiles.value) {
    if (isPicked(entry.path) !== check) emit('toggle', entry.path)
  }
}

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
    present(e, 'github.repoTree.errors.listDirectory')
  } finally {
    loading.value = false
  }
}

function pick(path: string) {
  if (props.multiple) {
    // Already-on-board directories are shown for orientation but can't be re-added.
    if (addedSet.value.has(normalizeRepoPath(path))) return
    emit('toggle', path)
  } else {
    emit('update:modelValue', pickedPathFor(path))
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
            v-if="clashes(entry)"
            class="flex shrink-0 items-center gap-1 text-xs text-amber-400"
          >
            <UIcon name="i-lucide-circle-alert" class="h-3.5 w-3.5" />
            {{ t('github.repoTree.exists') }}
          </span>
          <span
            v-else-if="mode === 'dir' && isAdded(entry.path)"
            class="flex shrink-0 items-center gap-1 text-xs text-slate-500"
          >
            <UIcon name="i-lucide-check" class="h-3.5 w-3.5" />
            {{ t('github.repoTree.added') }}
          </span>
          <UButton
            v-else-if="mode === 'dir' && !placingNewDir"
            size="xs"
            variant="soft"
            :color="isPicked(entry.path) ? 'primary' : 'neutral'"
            @click="pick(entry.path)"
          >
            {{ isPicked(entry.path) ? t('github.repoTree.selected') : t('github.repoTree.select') }}
          </UButton>
        </li>
        <template v-if="mode === 'file'">
          <!-- multiple: a bulk header so a whole directory of documents is one click -->
          <li
            v-if="selectableFiles.length > 1"
            class="flex items-center gap-2 bg-slate-900/60 px-3 py-1.5"
          >
            <UCheckbox
              :model-value="allSelected"
              :aria-label="
                t(
                  'github.repoTree.selectAllFiles',
                  { count: selectableFiles.length },
                  selectableFiles.length,
                )
              "
              data-testid="repo-tree-select-all"
              @update:model-value="toggleAllFiles"
            />
            <button
              type="button"
              class="text-xs text-slate-400 hover:text-primary-400"
              @click="toggleAllFiles"
            >
              {{
                t(
                  'github.repoTree.selectAllFiles',
                  { count: selectableFiles.length },
                  selectableFiles.length,
                )
              }}
            </button>
          </li>
          <li
            v-for="entry in fileEntries"
            :key="entry.path"
            class="flex items-center justify-between gap-2 px-3 py-1.5"
          >
            <div class="flex min-w-0 items-center gap-2">
              <UCheckbox
                v-if="multiple && !isAdded(entry.path)"
                :model-value="isPicked(entry.path)"
                :aria-label="entry.name"
                @update:model-value="pick(entry.path)"
              />
              <button
                type="button"
                class="flex items-center gap-2 truncate text-sm hover:text-primary-400"
                :class="isPicked(entry.path) ? 'text-primary-400' : 'text-slate-300'"
                :disabled="isAdded(entry.path)"
                @click="pick(entry.path)"
              >
                <UIcon name="i-lucide-file" class="h-4 w-4 shrink-0 text-slate-400" />
                <span class="truncate">{{ entry.name }}</span>
              </button>
            </div>
            <span
              v-if="isAdded(entry.path)"
              class="flex shrink-0 items-center gap-1 text-xs text-slate-500"
            >
              <UIcon name="i-lucide-check" class="h-3.5 w-3.5" />
              {{ t('github.repoTree.added') }}
            </span>
            <UIcon
              v-else-if="!multiple && isPicked(entry.path)"
              name="i-lucide-check"
              class="h-4 w-4 shrink-0 text-primary-400"
            />
          </li>
        </template>
      </ul>
    </div>

    <!-- placing a new directory: the pick is a LOCATION, so the repo root is a valid answer
         (unlike a plain dir pick, where the root means "the whole repo") and the target path
         is spelled out beside the button rather than left to be inferred from the crumbs -->
    <div v-if="placingNewDir" class="mt-2 flex items-center justify-between gap-2">
      <p
        class="min-w-0 truncate text-xs"
        :class="nameTakenHere ? 'text-amber-400' : 'text-slate-400'"
      >
        <template v-if="nameTakenHere">
          {{ t('github.repoTree.nameTaken', { name: newDirName }) }}
        </template>
        <template v-else>
          {{ t('github.repoTree.newDirTarget') }}
          <code class="text-slate-200">{{ pickedPathFor(currentPath) }}</code>
        </template>
      </p>
      <UButton
        size="xs"
        variant="soft"
        :color="isPicked(currentPath) ? 'primary' : 'neutral'"
        :disabled="loading || nameTakenHere"
        data-testid="repo-tree-create-here"
        @click="pick(currentPath)"
      >
        {{
          isPicked(currentPath) ? t('github.repoTree.selected') : t('github.repoTree.createHere')
        }}
      </UButton>
    </div>

    <!-- dir mode: pin the current folder without descending into a child -->
    <div
      v-else-if="mode === 'dir' && currentPath && !isAdded(currentPath)"
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
