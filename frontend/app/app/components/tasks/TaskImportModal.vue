<script setup lang="ts">
// Import an issue from a connected task source (by key or URL) and review the
// issues already imported into the workspace. An imported issue can be attached
// to an existing task for context from the inspector (see TaskContextIssues.vue),
// or turned directly into a new board task here — pick a container (service frame
// or module) and "Create task", which seeds a leaf block from the issue and links
// the issue to it for context.
import type { Block, TaskSearchResult, TaskSourceKind } from '~/types/domain'

const ui = useUiStore()
const tasks = useTasksStore()
const board = useBoardStore()
const toast = useToast()

const open = computed({
  get: () => ui.taskImport !== null,
  set: (v: boolean) => {
    if (!v) ui.closeTaskImport()
  },
})

const source = ref<TaskSourceKind | undefined>(undefined)
const ref_ = ref('')
const importing = ref(false)

// When opened from a service frame the modal is the "create a task from an issue"
// surface; opened standalone it's the general tracker-issue browser/importer.
const title = computed(() =>
  ui.taskImport?.containerId ? 'Create task from issue' : 'Tracker issues',
)

const sourceItems = computed(() =>
  tasks.offeredSources.map((s) => ({ label: s.label, value: s.source })),
)
const descriptor = computed(() => (source.value ? tasks.descriptorFor(source.value) : undefined))
const searchable = computed(() => descriptor.value?.searchable ?? false)

// The container (service frame or module) a new task is created in. Also the repo
// scope for the issue search — declared up here so the search watch can read it.
const containerId = ref<string | undefined>(undefined)

// Browse the tracker by free text so an issue can be turned into a task without
// knowing its key. Debounced; a created/imported hit also lands in the list below.
const searchQuery = ref('')
const searchResults = ref<TaskSearchResult[]>([])
const searching = ref(false)
const searchError = ref<string | null>(null)

let searchTimer: ReturnType<typeof setTimeout> | undefined
// Re-run when the chosen container changes too: a GitHub search is scoped to the
// selected service's repo, so switching containers re-scopes the results.
watch([searchQuery, source, () => containerId.value], () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchResults.value = []
  searchError.value = null
  const q = searchQuery.value.trim()
  if (!q || !searchable.value) return
  searchTimer = setTimeout(runSearch, 300)
})

async function runSearch() {
  const q = searchQuery.value.trim()
  if (!q || !source.value) return
  searching.value = true
  searchError.value = null
  try {
    // Scope to the selected container's repo so hits stay in-repo and a pasted
    // URL / bare issue number resolves to the exact issue.
    searchResults.value = await tasks.search(source.value, q, containerId.value)
  } catch (e) {
    searchResults.value = []
    searchError.value = e instanceof Error ? e.message : String(e)
  } finally {
    searching.value = false
  }
}

// Search hits not yet imported (imported ones already render in the list below).
const importedIds = computed(
  () => new Set(tasks.tasks.filter((t) => t.source === source.value).map((t) => t.externalId)),
)
const freshHits = computed(() =>
  searchResults.value.filter((r) => !importedIds.value.has(r.externalId)),
)

const sourceTasks = computed(() =>
  source.value ? tasks.tasks.filter((t) => t.source === source.value) : [],
)

// Containers a new task can be created in: every service frame and module on the
// board. Modules are labelled with their parent frame so the choice is unambiguous.
const containerItems = computed(() =>
  board.blocks
    .filter((b) => b.level === 'frame' || b.level === 'module')
    .map((b) => ({
      label:
        b.level === 'module'
          ? `${board.getBlock(b.parentId ?? '')?.title ?? '?'} › ${b.title}`
          : b.title,
      value: b.id,
    })),
)
// The issue currently being turned into a task (its row shows a spinner).
const creatingId = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    ref_.value = ''
    searchQuery.value = ''
    searchResults.value = []
    searchError.value = null
    source.value = ui.taskImport?.source ?? tasks.offeredSources[0]?.source ?? undefined
    // Opened from a service frame → preselect it as the create-in target (and the
    // search's repo scope); otherwise fall back to the first container on the board.
    containerId.value = ui.taskImport?.containerId ?? containerItems.value[0]?.value
    creatingId.value = null
    tasks.loadTasks().catch(() => {})
  }
})

// Create a board task from an issue, seeding its title/description from the issue
// and linking it back for writeback. A search hit isn't projected locally yet, so
// `needsImport` fetches + persists it first (create-block requires it imported).
async function createTask(externalId: string, needsImport = false) {
  if (!source.value || !containerId.value) return
  creatingId.value = externalId
  try {
    if (needsImport) await tasks.importTask(source.value, externalId)
    const { block } = await tasks.createTaskFromIssue(source.value, externalId, containerId.value)
    board.upsert(block as Block)
    toast.add({ title: `Created task "${block.title}"`, icon: 'i-lucide-square-check' })
  } catch (e) {
    toast.add({
      title: 'Could not create task',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    creatingId.value = null
  }
}

async function doImport() {
  const value = ref_.value.trim()
  if (!value || !source.value) return
  importing.value = true
  try {
    const task = await tasks.importTask(source.value, value)
    ref_.value = ''
    toast.add({ title: `Imported "${task.title}"`, icon: 'i-lucide-file-down' })
  } catch (e) {
    toast.add({
      title: 'Import failed',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="title">
    <template #body>
      <!-- Empty state: no source offered (none connected/installed, or all disabled) -->
      <div v-if="!tasks.anyOffered" class="space-y-3 text-center">
        <UIcon name="i-lucide-plug" class="mx-auto h-8 w-8 text-slate-500" />
        <p class="text-sm text-slate-400">Connect or enable a task source first.</p>
        <div class="flex justify-center gap-2">
          <UButton
            v-for="s in tasks.sources"
            :key="s.source"
            color="primary"
            variant="soft"
            :icon="s.icon"
            @click="ui.openTaskConnect(s.source)"
          >
            {{ s.available ? `Enable ${s.label}` : `Connect ${s.label}` }}
          </UButton>
        </div>
      </div>

      <!-- Main form -->
      <div v-else class="space-y-4">
        <UFormField v-if="sourceItems.length > 1" label="Source">
          <USelect v-model="source" :items="sourceItems" class="w-full" />
        </UFormField>

        <div class="flex items-end gap-2">
          <UFormField :label="descriptor?.refLabel ?? 'Issue key or URL'" class="flex-1">
            <UInput
              v-model="ref_"
              :placeholder="descriptor?.refPlaceholder"
              class="w-full"
              @keydown.enter="doImport"
            />
          </UFormField>
          <UButton
            color="primary"
            icon="i-lucide-file-down"
            :loading="importing"
            :disabled="!ref_.trim()"
            @click="doImport"
          >
            Import
          </UButton>
        </div>

        <!-- Browse: search the tracker by title so an issue can be turned into a
             task without knowing its key. -->
        <UFormField v-if="searchable" label="Search issues">
          <UInput
            v-model="searchQuery"
            :icon="searching ? 'i-lucide-loader-circle' : 'i-lucide-search'"
            :ui="{ leadingIcon: searching ? 'animate-spin' : '' }"
            placeholder="Search by title, paste an issue URL, or type an issue number…"
            class="w-full"
          />
        </UFormField>

        <!-- Shared target container for every "Create task" action below. -->
        <UFormField
          v-if="containerItems.length && (freshHits.length || sourceTasks.length)"
          label="Create tasks in"
          class="w-72"
        >
          <USelect
            v-model="containerId"
            :items="containerItems"
            placeholder="Pick a frame or module"
            class="w-full"
          />
        </UFormField>
        <p
          v-else-if="!containerItems.length && (freshHits.length || sourceTasks.length)"
          class="text-[11px] text-slate-500"
        >
          Add a service frame to the board first to create tasks from issues.
        </p>

        <!-- Search results (not yet imported): create a task directly from a hit. -->
        <div v-if="searchError" class="text-[11px] text-amber-400">
          Search failed: {{ searchError }}
        </div>
        <div v-if="freshHits.length" class="space-y-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Search results
          </h3>
          <div
            v-for="hit in freshHits"
            :key="`hit:${hit.source}:${hit.externalId}`"
            class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <a
                  :href="hit.url"
                  target="_blank"
                  rel="noopener"
                  class="truncate text-sm font-medium text-white hover:underline"
                >
                  {{ hit.externalId }} · {{ hit.title }}
                </a>
                <p v-if="hit.excerpt" class="mt-0.5 line-clamp-2 text-xs text-slate-500">
                  {{ hit.excerpt }}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <UBadge v-if="hit.status" color="neutral" variant="soft" size="xs">
                  {{ hit.status }}
                </UBadge>
                <UButton
                  color="primary"
                  variant="soft"
                  size="xs"
                  icon="i-lucide-square-check"
                  :loading="creatingId === hit.externalId"
                  :disabled="!containerId || creatingId !== null"
                  @click="createTask(hit.externalId, true)"
                >
                  Create task
                </UButton>
              </div>
            </div>
          </div>
        </div>

        <!-- List of already-imported issues -->
        <div v-if="sourceTasks.length" class="space-y-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Imported issues
          </h3>
          <div
            v-for="task in sourceTasks"
            :key="`${task.source}:${task.externalId}`"
            class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <a
                  :href="task.url"
                  target="_blank"
                  rel="noopener"
                  class="truncate text-sm font-medium text-white hover:underline"
                >
                  {{ task.externalId }} · {{ task.title }}
                </a>
                <p class="mt-0.5 line-clamp-2 text-xs text-slate-500">{{ task.excerpt }}</p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <UBadge color="neutral" variant="soft" size="xs">
                  {{ task.status }}
                </UBadge>
                <UButton
                  color="primary"
                  variant="soft"
                  size="xs"
                  icon="i-lucide-square-check"
                  :loading="creatingId === task.externalId"
                  :disabled="!containerId || creatingId !== null"
                  @click="createTask(task.externalId)"
                >
                  Create task
                </UButton>
              </div>
            </div>
          </div>
        </div>
        <p
          v-else-if="!freshHits.length && !searchQuery.trim()"
          class="text-center text-xs text-slate-500"
        >
          No issues imported yet. Search above, or paste an issue URL/key to import one.
        </p>
      </div>
    </template>
  </UModal>
</template>
