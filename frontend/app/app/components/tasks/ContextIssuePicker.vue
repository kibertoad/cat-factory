<script setup lang="ts">
// Inline picker for attaching a tracker issue as task context. It searches the
// connected tracker (GitHub Issues / Jira) by free text, lists already-imported
// issues for quick re-use, and accepts a pasted URL/key as a reference — all
// inline, with NO second modal (stacked page-level modals don't interact here).
// It only *stages* a choice: the caller collects PendingContext items and links
// them once the block exists (see useContextLinking). A search hit / pasted ref
// carries `needsImport: true` so it's fetched + persisted before linking.
//
// Search results are always confined to ONE repository (`scopeBlockId`'s service).
// An issue in another repo is reachable only by pasting its URL, which the explicit
// "attach by reference" row below imports directly — it never comes back as a hit,
// so what the search offers is exactly what the service owns.
//
// The tracker being searched is ALWAYS on screen (even when the workspace offers
// exactly one), and its menu doubles as the "add a tracker" affordance: attaching a
// context issue is where a missing integration is discovered, and the connect modal
// opens over the caller's form rather than navigating away from it.
import { useId } from 'vue'
import type { TaskSourceReadReason } from '@cat-factory/contracts'
import type { SourceTask, TaskSearchResult, TaskSourceKind } from '~/types/domain'
import { apiErrorReason } from '~/composables/api/errors'
import EmptyState from '~/components/common/EmptyState.vue'
import {
  type AddSourceLabels,
  buildSourceChoices,
  menuIsPickable,
  reconcileSource,
  sourceMenuItems,
} from '~/utils/sourcePicker'

const props = defineProps<{
  /** contextKeys already staged by the caller, so they're filtered out / not re-offered. */
  chosenKeys?: string[]
  /**
   * The block the picker is attaching context to (a service frame or a task/module
   * under one). REQUIRED: it is what scopes a GitHub search to that service's linked
   * repo, so hits stay in-repo and a bare issue number resolves to the exact issue.
   * A search with no scope reaches every repository the deployment's credential can
   * see (under a PAT, all of public GitHub), so there is no unscoped mode — a caller
   * that has no block yet must not render the picker.
   */
  scopeBlockId: string
  /**
   * Controlled source: when provided the parent owns the selected tracker (via
   * `v-model:source`); omitted, the picker manages it internally (the add-task case).
   */
  source?: TaskSourceKind
}>()
const emit = defineEmits<{
  pick: [item: PendingContext]
  'update:source': [value: TaskSourceKind]
}>()

const { t } = useI18n()
const tasks = useTasksStore()
const ui = useUiStore()

const chosen = computed(() => new Set(props.chosenKeys ?? []))

// Source: default to the first offered tracker. Controlled when the parent passes
// `source` (write-through to `update:source`), else internal. The selector is always
// rendered, single tracker or not — which tracker is being searched decides what a
// pasted key resolves to, so it must never be invisible.
const internalSource = ref<TaskSourceKind | undefined>(tasks.offeredSources[0]?.source)
const source = computed<TaskSourceKind | undefined>({
  get: () => props.source ?? internalSource.value,
  set: (v) => {
    internalSource.value = v
    if (v) emit('update:source', v)
  },
})
const descriptor = computed(() => (source.value ? tasks.descriptorFor(source.value) : undefined))

// The tracker the user left to connect, so it becomes the selection the moment it turns
// up offered (the connect modal re-probes on success). Also the reconcile trigger for a
// source that stops being offered — disconnected, or toggled off in settings.
const awaitingConnect = ref<TaskSourceKind | null>(null)
function addSource(s: TaskSourceKind) {
  awaitingConnect.value = s
  ui.openTaskConnect(s)
}
watch(
  () => tasks.offeredSources.map((s) => s.source),
  (offered) => {
    const next = reconcileSource(offered, source.value, awaitingConnect.value)
    if (next && next === awaitingConnect.value) awaitingConnect.value = null
    if (next !== source.value && next) source.value = next
  },
)

/** Wording per add action, exhaustive over what a TRACKER menu can carry. */
const ADD_LABEL: AddSourceLabels<'connect' | 'enable'> = {
  connect: (label) => t('tasks.picker.connectSource', { label }),
  enable: (label) => t('tasks.picker.enableSource', { label }),
}

// Two-tier menu: pick an offered tracker, or add one that isn't offered yet.
const sourceChoices = computed(() => buildSourceChoices(tasks.sources, source.value))
const sourceMenu = computed(() =>
  sourceMenuItems(sourceChoices.value, {
    onSelect: (s) => {
      source.value = s
    },
    onAdd: addSource,
    addLabel: ADD_LABEL,
  }),
)
/** One entry decides nothing, so the tracker is named as a label rather than as a dead control. */
const sourcePickable = computed(() => menuIsPickable(sourceChoices.value))

// The trigger's own content is the tracker NAME, which says nothing about what the name means, so
// the visible "Source" caption is joined to it as the accessible name ("Source GitHub"). Per
// instance, because this picker and the import modal's copy can be mounted at the same time and a
// hard-coded id would make one trigger claim the other's caption.
const sourceLabelId = useId()
const sourceTriggerId = useId()
const searchable = computed(() => descriptor.value?.searchable ?? false)

const query = ref('')
const results = ref<TaskSearchResult[]>([])
const searching = ref(false)
const searchError = ref<string | null>(null)

// Already-imported issues, scoped to the target container's repo on the backend
// (GitHub narrows to the service's linked repo, exactly as search does; repo-less
// sources are unaffected). Held locally rather than read from the shared workspace
// list, so a task created for one service never offers issues from sibling repos.
const imported = ref<SourceTask[]>([])
async function reloadImported() {
  try {
    imported.value = await tasks.listTasksForBlock(props.scopeBlockId)
  } catch {
    imported.value = []
  }
}
// Re-scope when the target container changes (its repo, hence the in-repo issues, differ).
watch(
  () => props.scopeBlockId,
  () => {
    reloadImported()
  },
)

// Debounced search: free text hits the tracker; a query that's clearly a URL/key
// is left to the explicit "by reference" row below (search won't surface it).
// Re-scope when `scopeBlockId` changes too (a GitHub search is scoped to the block's
// repo, so switching the target container re-runs against the new repo).
let timer: ReturnType<typeof setTimeout> | undefined
watch([query, source, () => props.scopeBlockId], () => {
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
    // "This service has no repo" is the one failure with an action attached, so it gets its
    // own localized copy off the backend's machine-readable reason rather than the raw
    // message (CLAUDE.md "Backend strings"). Anything else keeps the generic wording.
    const notLinked: TaskSourceReadReason = 'repo_not_linked'
    searchError.value =
      apiErrorReason(e) === notLinked
        ? t('tasks.picker.searchNeedsRepo')
        : t('tasks.picker.searchFailed', { error: e instanceof Error ? e.message : String(e) })
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
  return imported.value
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
    imported.value.filter((t) => t.source === source.value).map((t) => t.externalId),
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
  // Only worth offering when it looks like a reference, not a search phrase: a URL,
  // an owner/repo#n or #n GitHub ref, or a Jira/Linear-style key (PROJ-123, ENG-42).
  const looksLikeRef =
    q.includes('#') || q.includes('/') || /^https?:\/\//i.test(q) || /^[a-z][a-z0-9]*-\d+$/i.test(q)
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
  // Load the quick-pick list, scoped to the target container's repo.
  reloadImported()
})
</script>

<template>
  <div class="space-y-2 rounded-lg border border-slate-800 bg-slate-900/40 p-2">
    <!-- Which tracker is being searched, always visible, plus the trackers the user could add from
         here (each opens the connect modal over the caller's form). With a single entry there is
         nothing to decide, so the tracker is named as plain text: a chevron opening a one-item menu
         promises a choice that isn't there. `id` labels the trigger, whose own content is the
         tracker name rather than what that name means. -->
    <div class="flex items-center gap-1.5">
      <span
        :id="sourceLabelId"
        class="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
      >
        {{ t('tasks.picker.sourceLabel') }}
      </span>
      <UDropdownMenu
        v-if="sourcePickable"
        :items="sourceMenu"
        :content="{ side: 'bottom', align: 'start' }"
      >
        <UButton
          :id="sourceTriggerId"
          color="neutral"
          variant="soft"
          size="xs"
          :icon="icon"
          trailing-icon="i-lucide-chevron-down"
          class="max-w-full"
          :aria-labelledby="`${sourceLabelId} ${sourceTriggerId}`"
        >
          <span class="truncate">{{ descriptor?.label ?? t('tasks.picker.noSource') }}</span>
        </UButton>
      </UDropdownMenu>
      <span v-else class="flex min-w-0 items-center gap-1 text-xs text-slate-300">
        <UIcon :name="icon" class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate">{{ descriptor?.label ?? t('tasks.picker.noSource') }}</span>
      </span>
    </div>

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
      {{ searchError }}
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

      <EmptyState
        v-if="empty"
        compact
        icon="i-lucide-search-x"
        :title="
          query.trim()
            ? t('tasks.picker.noMatches')
            : searchable
              ? t('tasks.picker.emptySearchable')
              : t('tasks.picker.emptyRefOnly')
        "
      />
    </div>
  </div>
</template>
