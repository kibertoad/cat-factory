<script setup lang="ts">
// Inline picker for attaching a tracker issue as task context. It searches the
// connected tracker (GitHub Issues / Jira) by free text, lists already-imported
// issues for quick re-use, and accepts a pasted URL/key as a reference — all
// inline, with NO second modal (stacked page-level modals don't interact here).
// It only *stages* a choice: the caller collects PendingContext items and links
// them once the block exists (see useContextLinking). A search hit / pasted ref
// carries `needsImport: true` so it's fetched + persisted before linking.
import type { SourceTask, TaskSearchResult, TaskSourceKind } from '~/types/domain'

const props = defineProps<{
  /** contextKeys already staged by the caller, so they're filtered out / not re-offered. */
  chosenKeys?: string[]
  /**
   * The block the picker is attaching context to (a service frame or a task/module
   * under one). Scopes a GitHub search to that service's linked repo, so hits stay
   * in-repo and a pasted URL / bare issue number resolves to the exact issue.
   */
  scopeBlockId?: string
}>()
const emit = defineEmits<{ pick: [item: PendingContext] }>()

const { t } = useI18n()
const tasks = useTasksStore()

const chosen = computed(() => new Set(props.chosenKeys ?? []))

// Source: default to the first offered tracker; a selector appears only when more
// than one is offered (the common case is a single source).
const source = ref<TaskSourceKind | undefined>(tasks.offeredSources[0]?.source)
const sourceItems = computed(() =>
  tasks.offeredSources.map((s) => ({ label: s.label, value: s.source })),
)
const descriptor = computed(() => (source.value ? tasks.descriptorFor(source.value) : undefined))
const searchable = computed(() => descriptor.value?.searchable ?? false)

const query = ref('')
const results = ref<TaskSearchResult[]>([])
const searching = ref(false)
const searchError = ref<string | null>(null)

// Debounced search: free text hits the tracker; a query that's clearly a URL/key
// is left to the explicit "by reference" row below (search won't surface it).
let timer: ReturnType<typeof setTimeout> | undefined
watch([query, source], () => {
  if (timer) clearTimeout(timer)
  results.value = []
  searchError.value = null
  const q = query.value.trim()
  if (!q || !searchable.value) return
  timer = setTimeout(runSearch, 300)
})

async function runSearch() {
  const q = query.value.trim()
  if (!q || !source.value) return
  searching.value = true
  searchError.value = null
  try {
    results.value = await tasks.search(source.value, q, props.scopeBlockId)
  } catch (e) {
    results.value = []
    searchError.value = e instanceof Error ? e.message : String(e)
  } finally {
    searching.value = false
  }
}

const icon = computed(() => descriptor.value?.icon ?? 'i-lucide-square-check')

function keyFor(externalId: string): string {
  return source.value
    ? contextKey({ kind: 'task', source: source.value, externalId })
    : `task::${externalId}`
}

// Already-imported issues for this source, filtered by the query and never
// re-offering one the caller already staged.
const importedRows = computed(() => {
  if (!source.value) return []
  const q = query.value.trim().toLowerCase()
  return tasks.tasks
    .filter((t) => t.source === source.value)
    .filter((t) => !chosen.value.has(keyFor(t.externalId)))
    .filter(
      (t) => !q || t.externalId.toLowerCase().includes(q) || t.title.toLowerCase().includes(q),
    )
})

// Search hits not already imported (those show in importedRows) and not staged.
const searchRows = computed(() => {
  if (!source.value) return []
  const importedIds = new Set(
    tasks.tasks.filter((t) => t.source === source.value).map((t) => t.externalId),
  )
  return results.value
    .filter((r) => !importedIds.has(r.externalId))
    .filter((r) => !chosen.value.has(keyFor(r.externalId)))
})

// A pasted URL / key the search won't match: offer it as an explicit reference.
const refRow = computed(() => {
  const q = query.value.trim()
  if (!q || !source.value) return null
  const known =
    importedRows.value.some((t) => t.externalId === q) ||
    searchRows.value.some((r) => r.externalId === q) ||
    chosen.value.has(keyFor(q))
  if (known) return null
  // Only worth offering when it looks like a reference, not a search phrase.
  const looksLikeRef = q.includes('#') || q.includes('/') || /^https?:\/\//i.test(q)
  return looksLikeRef ? q : null
})

const empty = computed(
  () =>
    !searching.value &&
    !searchError.value &&
    importedRows.value.length === 0 &&
    searchRows.value.length === 0 &&
    refRow.value === null,
)

function pickImported(task: SourceTask) {
  if (!source.value) return
  emit('pick', {
    kind: 'task',
    source: source.value,
    externalId: task.externalId,
    title: `${task.externalId} · ${task.title}`,
    subtitle: task.status || undefined,
    icon: icon.value,
    // Already imported, so its body is in hand — carry it so the add-task form can
    // show it read-only and fold it into the new task's description.
    description: task.description || undefined,
    needsImport: false,
  })
}

function pickSearch(r: TaskSearchResult) {
  emit('pick', {
    kind: 'task',
    source: r.source,
    externalId: r.externalId,
    title: `${r.externalId} · ${r.title}`,
    subtitle: r.status || undefined,
    icon: icon.value,
    needsImport: true,
  })
}

function pickRef(q: string) {
  if (!source.value) return
  emit('pick', {
    kind: 'task',
    source: source.value,
    externalId: q,
    title: q,
    subtitle: descriptor.value?.label,
    icon: icon.value,
    needsImport: true,
  })
  query.value = ''
}

onMounted(() => {
  // Keep the quick-pick list current (cheap; the store dedupes).
  tasks.loadTasks().catch(() => {})
})
</script>

<template>
  <div class="space-y-2 rounded-lg border border-slate-800 bg-slate-900/40 p-2">
    <USelect
      v-if="sourceItems.length > 1"
      v-model="source"
      :items="sourceItems"
      size="xs"
      class="w-full"
    />

    <UInput
      v-model="query"
      :icon="searching ? 'i-lucide-loader-circle' : 'i-lucide-search'"
      :ui="{ leadingIcon: searching ? 'animate-spin' : '' }"
      size="sm"
      class="w-full"
      :placeholder="
        searchable
          ? t('tasks.picker.searchPlaceholder')
          : (descriptor?.refPlaceholder ?? t('tasks.picker.refPlaceholder'))
      "
      @keydown.enter="refRow && pickRef(refRow)"
    />

    <p v-if="searchError" class="px-1 text-[11px] text-amber-400">
      {{ t('tasks.picker.searchFailed', { error: searchError }) }}
    </p>

    <div class="max-h-56 space-y-0.5 overflow-y-auto">
      <!-- Already-imported issues (linked directly, no re-fetch). -->
      <button
        v-for="row in importedRows"
        :key="`imp:${row.externalId}`"
        type="button"
        class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs text-slate-300 hover:bg-slate-800/70"
        @click="pickImported(row)"
      >
        <UIcon :name="icon" class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
        <span class="truncate">{{ row.externalId }} · {{ row.title }}</span>
        <UBadge color="neutral" variant="soft" size="xs" class="ms-auto shrink-0">{{
          t('tasks.picker.imported')
        }}</UBadge>
      </button>

      <!-- Tracker search hits (imported on add). -->
      <button
        v-for="r in searchRows"
        :key="`hit:${r.externalId}`"
        type="button"
        class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs text-slate-300 hover:bg-slate-800/70"
        @click="pickSearch(r)"
      >
        <UIcon :name="icon" class="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span class="truncate">{{ r.externalId }} · {{ r.title }}</span>
        <UBadge v-if="r.status" color="neutral" variant="soft" size="xs" class="ms-auto shrink-0">
          {{ r.status }}
        </UBadge>
      </button>

      <!-- Explicit URL/key reference (imported on add). -->
      <button
        v-if="refRow"
        type="button"
        class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs text-slate-300 hover:bg-slate-800/70"
        @click="pickRef(refRow)"
      >
        <UIcon name="i-lucide-link" class="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span class="truncate">
          <i18n-t keypath="tasks.picker.attachByReference" tag="span" scope="global">
            <template #ref>
              <span class="text-slate-200">{{ refRow }}</span>
            </template>
          </i18n-t>
        </span>
      </button>

      <p v-if="empty" class="px-2 py-1.5 text-[11px] text-slate-500">
        {{
          query.trim()
            ? t('tasks.picker.noMatches')
            : searchable
              ? t('tasks.picker.emptySearchable')
              : t('tasks.picker.emptyRefOnly')
        }}
      </p>
    </div>
  </div>
</template>
