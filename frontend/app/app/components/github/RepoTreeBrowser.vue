<script setup lang="ts">
// A reusable GitHub repo tree browser: lists one level of a repo at a time
// (breadcrumb-navigable) and lets the user PICK a path. Two modes:
//   - `dir`  — pick a subdirectory (the monorepo service-directory picker), and
//   - `file` — pick a file (the service docker-compose location picker).
// The selected path (relative to the repo root, as GitHub returns it) is exposed
// via `v-model`. The component owns its own navigation/loading state so callers
// just bind a repo id + mode; it self-loads on mount and when those change.
import type { RepoTreeEntry } from '~/types/domain'

const props = withDefaults(
  defineProps<{
    repoGithubId: number
    mode?: 'dir' | 'file'
    /** Currently picked path (repo-root-relative), via v-model. */
    modelValue?: string
    /** Directory to open at (e.g. a monorepo service's subdirectory). */
    startPath?: string
  }>(),
  { mode: 'dir', startPath: '' },
)
const emit = defineEmits<{ 'update:modelValue': [string | undefined] }>()

const github = useGitHubStore()
const toast = useToast()

const currentPath = ref(props.startPath)
const treeEntries = ref<RepoTreeEntry[]>([])
const loading = ref(false)

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
      title: 'Could not list directory',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    loading.value = false
  }
}

function pick(path: string) {
  emit('update:modelValue', path)
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
        root
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
      <div v-if="loading" class="p-3 text-sm text-slate-400">Loading…</div>
      <div v-else-if="isEmpty" class="p-3 text-sm text-slate-400">
        {{ mode === 'dir' ? 'No subdirectories here.' : 'Nothing here.' }}
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
            v-if="mode === 'dir'"
            size="xs"
            variant="soft"
            :color="modelValue === entry.path ? 'primary' : 'neutral'"
            @click="pick(entry.path)"
          >
            {{ modelValue === entry.path ? 'Selected' : 'Select' }}
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
    <div v-if="mode === 'dir' && currentPath" class="mt-2 flex justify-end">
      <UButton
        size="xs"
        variant="soft"
        :color="modelValue === currentPath ? 'primary' : 'neutral'"
        @click="pick(currentPath)"
      >
        Use this folder
      </UButton>
    </div>
  </div>
</template>
