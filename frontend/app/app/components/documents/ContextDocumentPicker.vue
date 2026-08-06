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
// A PASTED REF IS RESOLVED BEFORE IT CAN BE STAGED, and that is the point of the ref
// half of this picker. It used to stage whatever text was in the box, so a share link
// carrying a title segment and `?p=`/`&t=` tracking params (what Figma's own Copy link
// button produces) was accepted verbatim, and a link the source could not read at all
// was accepted just as readily. The verdict arrived as a failed import AFTER the task
// had been created. The resolve call is the source's own `parseRef`, so what is shown
// here is what the import will do: the canonical trimmed link when it parses, and one
// of two named corrections when it does not (see `REF_REJECTIONS`).
import type { DocumentRefReason, DocumentSearchResult, DocumentSourceKind } from '~/types/domain'
import {
  classifyRefFailure,
  refCandidateOf,
  refRowFor,
  type RefState,
} from '~/components/documents/ContextDocumentPicker.logic'
import EmptyState from '~/components/common/EmptyState.vue'
import RepoContextDocPicker from '~/components/documents/RepoContextDocPicker.vue'

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

const chosen = computed(() => new Set(props.chosenKeys ?? []))

// Source: default to the first connected source; a selector appears only when
// more than one is connected (the common case is a single source).
const source = ref<DocumentSourceKind | undefined>(documents.connectedSources[0]?.source)
const sourceItems = computed(() =>
  documents.connectedSources.map((s) => ({ label: s.label, value: s.source })),
)
const descriptor = computed(() =>
  source.value ? documents.descriptorFor(source.value) : undefined,
)
const searchable = computed(() => descriptor.value?.searchable ?? false)
// A repo-backed source swaps the whole free-text search body for the repo→file picker.
const isRepoSource = computed(() => !!source.value && REPO_SOURCES.has(source.value))

const query = ref('')
const results = ref<DocumentSearchResult[]>([])
const searching = ref(false)
const searchError = ref<string | null>(null)

// What the ref half of the picker knows about the current query. A refusal carries the backend's
// machine-readable REASON rather than its prose, because the two reasons ask for different
// corrections and only one of them is fixable from here (see `REF_REJECTIONS`).
const refState = ref<RefState>({ status: 'none' })
// Monotonic token so a slow resolve for an earlier query cannot land on a later one: the
// input is resolved on every keystroke, so out-of-order responses are the normal case.
let refSeq = 0

/** A source's display name, for a kind the backend named in a refusal (never a raw slug). */
function sourceLabel(kind: string): string {
  return documents.sources.find((s) => s.source === kind)?.label ?? kind
}

/**
 * Translated copy per refusal reason, an exhaustive `Record` over the closed union so a reason
 * added on the backend fails the typecheck here rather than reaching the user as English server
 * prose. Each message names the correction that reason actually calls for.
 */
const REF_REJECTIONS: Record<
  DocumentRefReason,
  (input: { claimedBy?: string; expected?: string }) => string
> = {
  document_ref_unrecognized: ({ expected }) =>
    t('documents.picker.refUnrecognized', {
      source: sourceLabel(source.value ?? ''),
      expected: expected ?? descriptor.value?.refPlaceholder ?? '',
    }),
  document_ref_claimed_by_other_source: ({ claimedBy }) =>
    t('documents.picker.refOtherSource', {
      source: sourceLabel(source.value ?? ''),
      claimed: sourceLabel(claimedBy ?? ''),
    }),
}

/** The text to resolve as a reference, or null when there is nothing to resolve. */
const refCandidate = computed(() =>
  source.value ? refCandidateOf(query.value, searchable.value) : null,
)

// Debounced search: free text hits the source; a query that's clearly a URL/ID
// is left to the explicit "by reference" row below (search won't surface it).
let timer: ReturnType<typeof setTimeout> | undefined
watch([query, source], () => {
  if (timer) clearTimeout(timer)
  results.value = []
  searchError.value = null
  refState.value = { status: 'none' }
  refSeq++
  const q = query.value.trim()
  if (!q) return
  timer = setTimeout(() => {
    if (searchable.value) void runSearch()
    if (refCandidate.value) void resolveRef(refCandidate.value)
  }, 300)
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

/**
 * Ask the backend what this text resolves to for the selected source. A 422 is the source's
 * own refusal and lands as `rejected` with its reason; anything else (offline, 5xx) leaves
 * the ref UNCHECKED rather than refused, so an outage in the pre-flight never reads to the
 * user as "your link is wrong".
 */
async function resolveRef(candidate: string) {
  const src = source.value
  if (!src) return
  const seq = ++refSeq
  refState.value = { status: 'checking' }
  try {
    const ref = await documents.resolveRef(src, candidate)
    if (seq === refSeq) refState.value = { status: 'ok', ref }
  } catch (e) {
    if (seq !== refSeq) return
    refState.value = classifyRefFailure(e)
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

/** The already-imported document a resolved ref points at, when the workspace holds it. */
const refImported = computed(() => {
  const state = refState.value
  if (state.status !== 'ok') return undefined
  return documents.documents.find(
    (d) => d.source === state.ref.source && d.externalId === state.ref.externalId,
  )
})

/**
 * The attachable row for a resolved ref: the CANONICAL form the source settled on, never the
 * text that was typed. Suppressed once the same reference is already staged, keyed on the
 * resolved external id, so pasting the share link and then the bare id cannot stage it twice.
 */
const refRow = computed(() => {
  const state = refState.value
  const pasted = refCandidate.value
  if (state.status !== 'ok' || !pasted) return null
  if (chosen.value.has(keyFor(state.ref.externalId))) return null
  return {
    ref: state.ref,
    imported: !!refImported.value,
    ...refRowFor(state.ref, pasted, refImported.value?.title),
  }
})

/** The refusal to render under the input, in the reader's language, or null. */
const refRejection = computed(() => {
  const state = refState.value
  if (state.status !== 'rejected') return null
  return REF_REJECTIONS[state.reason]({
    ...(state.claimedBy ? { claimedBy: state.claimedBy } : {}),
    ...(state.expected ? { expected: state.expected } : {}),
  })
})

/**
 * The source named by a `claimed_by_other_source` refusal, when it is one this workspace has
 * connected. Absent when it is not: offering to switch to a source the picker cannot select
 * would be a dead end, and the refusal copy alone already names what the link is.
 */
const refSwitchTarget = computed(() => {
  const state = refState.value
  if (state.status !== 'rejected' || !state.claimedBy) return undefined
  return documents.connectedSources.find((s) => s.source === state.claimedBy)
})

function switchToClaimingSource() {
  const target = refSwitchTarget.value
  if (target) source.value = target.source
}

const empty = computed(
  () =>
    !searching.value &&
    !searchError.value &&
    importedRows.value.length === 0 &&
    searchRows.value.length === 0 &&
    refRow.value === null &&
    refState.value.status === 'none',
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

/**
 * Stage a RESOLVED reference. The canonical external id is staged, never the pasted text, so
 * the item the host commits is the one the pre-flight judged. A reference the workspace has
 * already imported skips the re-fetch (`needsImport: false`) and carries its real title.
 */
function pickRef(row: NonNullable<typeof refRow.value>) {
  emit('pick', {
    kind: 'document',
    source: row.ref.source,
    externalId: row.ref.externalId,
    title: row.label,
    subtitle: row.ref.canonicalUrl ?? descriptor.value?.label,
    icon: icon.value,
    needsImport: !row.imported,
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
    <USelect
      v-if="sourceItems.length > 1"
      v-model="source"
      :items="sourceItems"
      size="xs"
      class="w-full"
    />

    <!-- Repo-backed source (GitHub / GitLab): pick a repository, then a file. -->
    <RepoContextDocPicker
      v-if="isRepoSource && source"
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

      <!-- The pre-flight's verdict on a pasted ref. A refusal is stated HERE, under the input
           the user can still edit, rather than as a toast after the task is created. -->
      <p
        v-if="refState.status === 'checking'"
        class="px-1 text-[11px] text-slate-500"
        data-testid="doc-ref-checking"
      >
        {{ t('documents.picker.refChecking') }}
      </p>
      <div
        v-else-if="refRejection"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-amber-400"
        data-testid="doc-ref-rejected"
      >
        <span>{{ refRejection }}</span>
        <UButton
          v-if="refSwitchTarget"
          color="neutral"
          variant="link"
          size="xs"
          class="p-0"
          data-testid="doc-ref-switch-source"
          @click="switchToClaimingSource"
        >
          {{ t('documents.picker.refSwitchSource', { source: refSwitchTarget.label }) }}
        </UButton>
      </div>
      <p
        v-else-if="refState.status === 'unchecked'"
        class="px-1 text-[11px] text-amber-400"
        data-testid="doc-ref-unchecked"
      >
        {{ t('documents.picker.refCheckFailed', { error: refState.message }) }}
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

        <!-- Explicit URL/ID reference, RESOLVED: the row shows the canonical form the source
             settled on, so a share link's title segment and tracking params are visibly gone
             before the attachment is staged. -->
        <button
          v-if="refRow"
          type="button"
          class="flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-start text-xs text-slate-300 hover:bg-slate-800/70"
          data-testid="doc-ref-attach"
          @click="pickRef(refRow)"
        >
          <UIcon name="i-lucide-link" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span class="min-w-0">
            <span class="block truncate">
              <i18n-t keypath="documents.picker.attachByReference" scope="global">
                <template #ref>
                  <span class="text-slate-200">{{ refRow.label }}</span>
                </template>
              </i18n-t>
            </span>
            <span v-if="refRow.trimmed" class="block truncate text-[11px] text-slate-500">
              {{ t('documents.picker.refTrimmed') }}
            </span>
          </span>
          <UBadge
            v-if="refRow.imported"
            color="neutral"
            variant="soft"
            size="xs"
            class="ms-auto shrink-0"
          >
            {{ t('documents.picker.importedBadge') }}
          </UBadge>
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
