<script setup lang="ts">
// A self-contained picker for attaching external context (imported docs +
// tracker issues) to a task. It surfaces the existing integrations — Confluence /
// Notion / GitHub repo docs (documents) and Jira / GitHub issues (tasks) — behind
// one control: pick a source, then either search its catalogue by title/content
// (when the source is searchable) or paste a page/issue URL or id, and pick from
// what's already been imported. Chosen items are collected into a v-model list of
// `PendingContext`; the parent links them once the block exists (see
// useContextLinking). Connection/availability gating mirrors the sidebar: a
// source that isn't connected shows a connect affordance instead of an input.
import type { DropdownMenuItem } from '@nuxt/ui'
import type {
  DocumentSearchResult,
  DocumentSourceKind,
  TaskSearchResult,
  TaskSourceKind,
} from '~/types/domain'

const model = defineModel<PendingContext[]>({ required: true })

const documents = useDocumentsStore()
const tasks = useTasksStore()
const ui = useUiStore()
const toast = useToast()

interface SourceOption {
  kind: 'document' | 'task'
  source: DocumentSourceKind | TaskSourceKind
  label: string
  icon: string
  searchable: boolean
  connected: boolean
  refLabel: string
  refPlaceholder: string
}

// Every configured source across both integrations, tagged by kind. Documents
// first, then trackers — the order the sidebar uses.
const sources = computed<SourceOption[]>(() => {
  const docs: SourceOption[] = documents.available
    ? documents.sources.map((s) => ({
        kind: 'document',
        source: s.source,
        label: s.label,
        icon: s.icon,
        searchable: s.searchable ?? false,
        connected: documents.isConnected(s.source),
        refLabel: s.refLabel,
        refPlaceholder: s.refPlaceholder,
      }))
    : []
  const issues: SourceOption[] = tasks.available
    ? tasks.sources.map((s) => ({
        kind: 'task',
        source: s.source,
        label: s.label,
        icon: s.icon,
        searchable: s.searchable ?? false,
        connected: tasks.isConnected(s.source),
        refLabel: s.refLabel,
        refPlaceholder: s.refPlaceholder,
      }))
    : []
  return [...docs, ...issues]
})

const selectedKey = ref('')
const selected = computed(() =>
  sources.value.find((s) => `${s.kind}:${s.source}` === selectedKey.value),
)

// Default the selection to the first connected source (else the first source),
// once the source list resolves.
watch(
  sources,
  (list) => {
    if (selected.value || list.length === 0) return
    selectedKey.value = `${(list.find((s) => s.connected) ?? list[0]!).kind}:${(list.find((s) => s.connected) ?? list[0]!).source}`
  },
  { immediate: true },
)

const sourceMenu = computed<DropdownMenuItem[][]>(() => [
  sources.value.map((s) => ({
    label: s.connected ? s.label : `${s.label} (not connected)`,
    icon: s.icon,
    onSelect: () => {
      selectedKey.value = `${s.kind}:${s.source}`
      query.value = ''
      results.value = []
    },
  })),
])

// The "set up a new integration" menu: every configured source, so the user can
// connect (or reconnect) one without leaving the add-task popup. Unconnected
// sources come first — those are the ones you'd typically be setting up here.
const connectMenu = computed<DropdownMenuItem[][]>(() => [
  [...sources.value]
    .sort((a, b) => Number(a.connected) - Number(b.connected))
    .map((s) => ({
      label: s.connected ? `${s.label} (reconnect)` : `Connect ${s.label}`,
      icon: s.icon,
      onSelect: () => connect(s),
    })),
])

// ---- search / import-by-ref ----------------------------------------------

const query = ref('')
const results = ref<(DocumentSearchResult | TaskSearchResult)[]>([])
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch([query, selectedKey], () => {
  results.value = []
  if (searchTimer) clearTimeout(searchTimer)
  const src = selected.value
  const q = query.value.trim()
  if (!src || !src.searchable || !src.connected || q.length < 2) return
  searchTimer = setTimeout(() => void runSearch(src, q), 300)
})

async function runSearch(src: SourceOption, q: string) {
  searching.value = true
  try {
    results.value =
      src.kind === 'document'
        ? await documents.search(src.source as DocumentSourceKind, q)
        : await tasks.search(src.source as TaskSourceKind, q)
  } catch {
    // A search failure (e.g. the source can't search, or a transient API error)
    // just yields no results — paste-a-URL still works.
    results.value = []
  } finally {
    searching.value = false
  }
}

const selectedKeys = computed(() => new Set(model.value.map(contextKey)))

function toggle(item: PendingContext) {
  const key = contextKey(item)
  if (selectedKeys.value.has(key)) {
    model.value = model.value.filter((c) => contextKey(c) !== key)
  } else {
    model.value = [...model.value, item]
  }
}

/** Attach the raw input as a page/issue ref (URL or id) — imported on commit. */
function addByRef() {
  const src = selected.value
  const ref = query.value.trim()
  if (!src || !ref) return
  toggle({
    kind: src.kind,
    source: src.source,
    externalId: ref,
    title: ref,
    subtitle: `${src.label} · imports on add`,
    icon: src.icon,
    needsImport: true,
  })
  query.value = ''
  results.value = []
}

function pickResult(src: SourceOption, r: DocumentSearchResult | TaskSearchResult) {
  toggle({
    kind: src.kind,
    source: src.source,
    externalId: r.externalId,
    title: r.title,
    subtitle: 'status' in r && r.status ? r.status : src.label,
    icon: src.icon,
    needsImport: true,
  })
}

// Already-imported items for the selected source, for quick re-attaching without
// a round-trip. Excludes anything already pending.
const imported = computed<PendingContext[]>(() => {
  const src = selected.value
  if (!src) return []
  const items: PendingContext[] =
    src.kind === 'document'
      ? documents.documents
          .filter((d) => d.source === src.source)
          .map((d) => ({
            kind: 'document' as const,
            source: d.source,
            externalId: d.externalId,
            title: d.title,
            subtitle: src.label,
            icon: src.icon,
            needsImport: false,
          }))
      : tasks.tasks
          .filter((t) => t.source === src.source)
          .map((t) => ({
            kind: 'task' as const,
            source: t.source,
            externalId: t.externalId,
            title: `${t.externalId} · ${t.title}`,
            subtitle: t.status || src.label,
            icon: src.icon,
            needsImport: false,
          }))
  return items.filter((i) => !selectedKeys.value.has(contextKey(i)))
})

function connect(src: SourceOption) {
  if (src.kind === 'document') ui.openDocumentConnect(src.source as DocumentSourceKind)
  else ui.openTaskConnect(src.source as TaskSourceKind)
  toast.add({
    title: `Connect ${src.label} — it'll be ready here once connected`,
    icon: 'i-lucide-plug',
  })
}
</script>

<template>
  <div v-if="sources.length" class="space-y-2">
    <div class="flex items-center gap-2">
      <UDropdownMenu :items="sourceMenu" class="shrink-0">
        <UButton
          color="neutral"
          variant="subtle"
          size="sm"
          :icon="selected?.icon ?? 'i-lucide-link'"
          trailing-icon="i-lucide-chevron-down"
        >
          {{ selected?.label ?? 'Source' }}
        </UButton>
      </UDropdownMenu>

      <UInput
        v-if="selected?.connected"
        v-model="query"
        :placeholder="
          selected?.searchable
            ? `Search ${selected?.label} or paste a URL…`
            : selected?.refPlaceholder
        "
        class="flex-1"
        :loading="searching"
        icon="i-lucide-search"
        @keydown.enter.prevent="addByRef"
      />

      <UDropdownMenu :items="connectMenu" class="ml-auto shrink-0">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
          title="Connect an integration"
        >
          Connect a source
        </UButton>
      </UDropdownMenu>
    </div>

    <!-- not-connected affordance -->
    <div
      v-if="selected && !selected.connected"
      class="flex items-center justify-between rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-400"
    >
      <span>{{ selected.label }} isn't connected yet.</span>
      <UButton
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-plug"
        @click="connect(selected)"
      >
        Connect
      </UButton>
    </div>

    <!-- search results + paste-by-URL -->
    <div v-if="selected?.connected && query.trim()" class="space-y-1">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded-md border border-dashed border-slate-700 bg-slate-900/40 px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/60"
        @click="addByRef"
      >
        <UIcon name="i-lucide-link" class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
        <span class="truncate">Link “{{ query.trim() }}” by URL or id</span>
      </button>
      <button
        v-for="r in results"
        :key="`${r.source}:${r.externalId}`"
        type="button"
        class="w-full rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/60"
        @click="pickResult(selected!, r)"
      >
        <span class="flex items-center gap-1.5">
          <UIcon
            :name="selected?.icon ?? 'i-lucide-file-text'"
            class="h-3.5 w-3.5 shrink-0 text-indigo-400"
          />
          <span class="truncate">{{ r.title }}</span>
          <UBadge
            v-if="'status' in r && r.status"
            color="neutral"
            variant="soft"
            size="xs"
            class="ml-auto shrink-0"
          >
            {{ r.status }}
          </UBadge>
        </span>
        <span v-if="r.excerpt" class="mt-0.5 block truncate pl-5 text-[11px] text-slate-500">
          {{ r.excerpt }}
        </span>
      </button>
      <p
        v-if="selected?.searchable && !searching && !results.length"
        class="px-1 text-[11px] text-slate-500"
      >
        No matches — or paste the exact URL/id above.
      </p>
    </div>

    <!-- already-imported quick pick -->
    <div v-if="imported.length" class="space-y-1">
      <span class="px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        Already imported
      </span>
      <button
        v-for="item in imported"
        :key="contextKey(item)"
        type="button"
        class="flex w-full items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-left text-xs text-slate-300 hover:bg-slate-800/60"
        @click="toggle(item)"
      >
        <UIcon
          :name="item.icon ?? 'i-lucide-file-text'"
          class="h-3.5 w-3.5 shrink-0 text-indigo-400"
        />
        <span class="truncate">{{ item.title }}</span>
      </button>
    </div>

    <!-- chosen items -->
    <div v-if="model.length" class="flex flex-wrap gap-1.5">
      <span
        v-for="item in model"
        :key="contextKey(item)"
        class="flex max-w-full items-center gap-1 rounded-full border border-indigo-500/60 bg-indigo-500/10 px-2 py-0.5 text-[11px] text-slate-200"
      >
        <UIcon :name="item.icon ?? 'i-lucide-link'" class="h-3 w-3 shrink-0 text-indigo-400" />
        <span class="truncate">{{ item.title }}</span>
        <button
          type="button"
          class="shrink-0 text-slate-400 hover:text-slate-200"
          @click="toggle(item)"
        >
          <UIcon name="i-lucide-x" class="h-3 w-3" />
        </button>
      </span>
    </div>
  </div>
</template>
