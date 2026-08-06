<script setup lang="ts">
// Inline picker for attaching a document (Confluence / Notion / GitHub page) as
// task context. It searches the connected source by free text, lists
// already-imported documents for quick re-use, and accepts a pasted URL/ID as a
// reference — all inline, with NO second modal (stacked page-level modals don't
// interact here, which is why the old "Import a page…" path appeared to open
// something but nothing was clickable). It only *stages* a choice: the caller
// collects PendingContext items and links them once the block exists (see
// useContextLinking). A search hit / pasted ref carries `needsImport: true` so
// it's fetched + persisted before linking. Mirrors ContextIssuePicker.
//
// The source being searched is ALWAYS on screen (even when the workspace has exactly one, and
// even when it has none), and its menu doubles as the "add a source" affordance: which source is
// selected decides what a pasted ref resolves to and which repository a file pick browses, and
// attaching context is where a missing integration is discovered. Connecting opens that source's
// connect modal OVER the caller's form rather than navigating away from it.
import type { DropdownMenuItem } from '@nuxt/ui'
import type { DocumentSearchResult, DocumentSourceKind } from '~/types/domain'
import EmptyState from '~/components/common/EmptyState.vue'
import RepoContextDocPicker from '~/components/documents/RepoContextDocPicker.vue'
import { buildSourceChoices, connectionSourceRows, reconcileSource } from '~/utils/sourcePicker'

// Repo-backed document sources pick a FILE out of a repository (repo search → file
// search / tree browse) instead of the generic free-text catalogue search. Today only
// `github` (which transparently covers GitLab via the VCS adapter) is repo-backed.
const REPO_SOURCES = new Set<DocumentSourceKind>(['github'])

const props = defineProps<{
  /** contextKeys already staged by the caller, so they're filtered out / not re-offered. */
  chosenKeys?: string[]
}>()
const emit = defineEmits<{ pick: [item: PendingContext] }>()

const { t } = useI18n()
const documents = useDocumentsStore()
const ui = useUiStore()
// Connecting a source stores a workspace credential and is admin-tier, while attaching what it
// holds is member-tier — so the menu's "add a source" tier is withheld from a member rather than
// offering a connect that would 403 (see `connectionSourceRows`).
const { canManageIntegrations } = useWorkspaceAccess()

const chosen = computed(() => new Set(props.chosenKeys ?? []))

// Source: default to the first connected source. The selector is always rendered, single source
// or not: which source is being searched decides what a pasted ref resolves to, so it must never
// be invisible.
const source = ref<DocumentSourceKind | undefined>(documents.connectedSources[0]?.source)
const descriptor = computed(() =>
  source.value ? documents.descriptorFor(source.value) : undefined,
)

// The source the user left to connect, so it becomes the selection the moment it turns up
// connected (the connect modal re-probes on success). Also the reconcile trigger for a source
// that stops being connected while the caller's form sat open.
const awaitingConnect = ref<DocumentSourceKind | null>(null)
function addSource(s: DocumentSourceKind) {
  awaitingConnect.value = s
  ui.openDocumentConnect(s)
}
watch(
  () => documents.connectedSources.map((s) => s.source),
  (connected) => {
    const next = reconcileSource(connected, source.value, awaitingConnect.value)
    if (next && next === awaitingConnect.value) awaitingConnect.value = null
    if (next !== source.value) source.value = next
  },
)

// Two-tier menu: pick a connected source, or connect one the workspace hasn't got yet. A
// document source carries no per-workspace enable toggle, so every add entry is a `connect`.
const sourceMenu = computed<DropdownMenuItem[][]>(() =>
  buildSourceChoices(
    connectionSourceRows(documents.sources, {
      isConnected: documents.isConnected,
      canConnect: canManageIntegrations.value,
    }),
    source.value,
  ).map((group) =>
    group.map((choice) =>
      choice.action === 'select'
        ? {
            label: choice.label,
            icon: choice.icon,
            trailingIcon: choice.active ? 'i-lucide-check' : undefined,
            onSelect: () => {
              source.value = choice.source
            },
          }
        : {
            label: t('documents.picker.connectSource', { label: choice.label }),
            icon: 'i-lucide-plug',
            onSelect: () => addSource(choice.source),
          },
    ),
  ),
)
const searchable = computed(() => descriptor.value?.searchable ?? false)
// A repo-backed source swaps the whole free-text search body for the repo→file picker.
const isRepoSource = computed(() => !!source.value && REPO_SOURCES.has(source.value))

const query = ref('')
const results = ref<DocumentSearchResult[]>([])
const searching = ref(false)
const searchError = ref<string | null>(null)

// Debounced search: free text hits the source; a query that's clearly a URL/ID
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
    results.value = await documents.search(source.value, q)
  } catch (e) {
    results.value = []
    searchError.value = e instanceof Error ? e.message : String(e)
  } finally {
    searching.value = false
  }
}

const icon = computed(() => descriptor.value?.icon ?? 'i-lucide-file-text')

function keyFor(externalId: string): string {
  return source.value
    ? contextKey({ kind: 'document', source: source.value, externalId })
    : `document::${externalId}`
}

// Already-imported documents for this source, filtered by the query and never
// re-offering one the caller already staged.
const importedRows = computed(() => {
  if (!source.value) return []
  const q = query.value.trim().toLowerCase()
  return documents.documents
    .filter((d) => d.source === source.value)
    .filter((d) => !chosen.value.has(keyFor(d.externalId)))
    .filter((d) => !q || d.title.toLowerCase().includes(q) || d.excerpt.toLowerCase().includes(q))
})

// Search hits not already imported (those show in importedRows) and not staged.
const searchRows = computed(() => {
  if (!source.value) return []
  const importedIds = new Set(
    documents.documents.filter((d) => d.source === source.value).map((d) => d.externalId),
  )
  return results.value
    .filter((r) => !importedIds.has(r.externalId))
    .filter((r) => !chosen.value.has(keyFor(r.externalId)))
})

// A pasted URL / ID the search won't match: offer it as an explicit reference.
// When the source isn't searchable, any non-empty query is treated as a ref (the
// only way to attach a page there, mirroring the import modal's single input).
const refRow = computed(() => {
  const q = query.value.trim()
  if (!q || !source.value) return null
  const known =
    importedRows.value.some((d) => d.externalId === q) ||
    searchRows.value.some((r) => r.externalId === q) ||
    chosen.value.has(keyFor(q))
  if (known) return null
  if (!searchable.value) return q
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

function pickImported(externalId: string, title: string, excerpt: string) {
  if (!source.value) return
  emit('pick', {
    kind: 'document',
    source: source.value,
    externalId,
    title,
    subtitle: excerpt || undefined,
    icon: icon.value,
    needsImport: false,
  })
}

function pickSearch(r: DocumentSearchResult) {
  emit('pick', {
    kind: 'document',
    source: r.source,
    externalId: r.externalId,
    title: r.title,
    subtitle: r.excerpt || undefined,
    icon: icon.value,
    needsImport: true,
  })
}

function pickRef(q: string) {
  if (!source.value) return
  emit('pick', {
    kind: 'document',
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
  documents.loadDocuments().catch(() => {})
})
</script>

<template>
  <div class="space-y-2 rounded-lg border border-slate-800 bg-slate-900/40 p-2">
    <!-- Which source is being searched, always visible, plus the sources the user could add
         from here (each opens the connect modal over the caller's form). -->
    <div class="flex items-center gap-1.5">
      <span class="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {{ t('documents.picker.sourceLabel') }}
      </span>
      <UDropdownMenu :items="sourceMenu" :content="{ side: 'bottom', align: 'start' }">
        <UButton
          color="neutral"
          variant="soft"
          size="xs"
          :icon="icon"
          trailing-icon="i-lucide-chevron-down"
          class="max-w-full"
        >
          <span class="truncate">{{ descriptor?.label ?? t('documents.picker.noSource') }}</span>
        </UButton>
      </UDropdownMenu>
    </div>

    <!-- No source selected: nothing is connected (or the last one was disconnected while this
         sat open), so the menu above is the only action left. Say that rather than render a
         search box that can only fail. -->
    <EmptyState
      v-if="!source"
      compact
      icon="i-lucide-plug"
      :title="t('documents.picker.needsSource')"
    />

    <!-- Repo-backed source (GitHub / GitLab): pick a repository, then a file. -->
    <RepoContextDocPicker
      v-else-if="isRepoSource"
      :source="source!"
      :icon="icon"
      :chosen-keys="chosenKeys"
      @pick="(item: PendingContext) => emit('pick', item)"
    />

    <template v-else>
      <UInput
        v-model="query"
        :icon="searching ? 'i-lucide-loader-circle' : 'i-lucide-search'"
        :ui="{ leadingIcon: searching ? 'animate-spin' : '' }"
        size="sm"
        class="w-full"
        :placeholder="
          searchable
            ? t('documents.picker.searchPlaceholder')
            : (descriptor?.refPlaceholder ?? t('documents.picker.refPlaceholder'))
        "
        @keydown.enter="refRow && pickRef(refRow)"
      />

      <p v-if="searchError" class="px-1 text-[11px] text-amber-400">
        {{ t('documents.picker.searchFailed', { error: searchError }) }}
      </p>

      <div class="max-h-56 space-y-0.5 overflow-y-auto">
        <!-- Already-imported documents (linked directly, no re-fetch). -->
        <button
          v-for="d in importedRows"
          :key="`imp:${d.externalId}`"
          type="button"
          class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs text-slate-300 hover:bg-slate-800/70"
          @click="pickImported(d.externalId, d.title, d.excerpt)"
        >
          <UIcon :name="icon" class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
          <span class="truncate">{{ d.title }}</span>
          <UBadge color="neutral" variant="soft" size="xs" class="ms-auto shrink-0">{{
            t('documents.picker.importedBadge')
          }}</UBadge>
        </button>

        <!-- Source search hits (imported on add). -->
        <button
          v-for="r in searchRows"
          :key="`hit:${r.externalId}`"
          type="button"
          class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs text-slate-300 hover:bg-slate-800/70"
          @click="pickSearch(r)"
        >
          <UIcon :name="icon" class="h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span class="truncate">{{ r.title }}</span>
        </button>

        <!-- Explicit URL/ID reference (imported on add). -->
        <button
          v-if="refRow"
          type="button"
          class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-xs text-slate-300 hover:bg-slate-800/70"
          @click="pickRef(refRow)"
        >
          <UIcon name="i-lucide-link" class="h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span class="truncate">
            <i18n-t keypath="documents.picker.attachByReference" scope="global">
              <template #ref>
                <span class="text-slate-200">{{ refRow }}</span>
              </template>
            </i18n-t>
          </span>
        </button>

        <EmptyState
          v-if="empty"
          compact
          icon="i-lucide-file-search"
          :title="
            query.trim()
              ? t('documents.picker.noMatches')
              : searchable
                ? t('documents.picker.emptySearchable')
                : t('documents.picker.emptyRefOnly')
          "
        />
      </div>
    </template>
  </div>
</template>
