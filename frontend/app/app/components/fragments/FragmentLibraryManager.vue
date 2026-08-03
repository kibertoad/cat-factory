<script setup lang="ts">
// Prompt-fragment library manager (ADR 0006), reused at two scopes: a board
// (`workspace`) and an `account`. Curate hand-authored fragments, link external
// documents as living fragments, link repos of Markdown guidelines (with a
// "changes available" badge + resync), and — at the workspace scope only — review
// the merged catalog (built-in ∪ account ∪ workspace) an agent is selected from per
// run. The account scope has no resolved/merged catalog and fetches document
// fragments through `viaWorkspaceId` (document-source credentials are per-workspace).
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type {
  DocumentSourceKind,
  FragmentOwnerKind,
  GitHubAvailableRepo,
  ResolvedFragment,
} from '~/types/domain'
import { useFragmentLibrary, useFragmentLibraryStore } from '~/stores/fragmentLibrary'
import { showOverrideField } from '~/utils/uiMode'
import GitHubRepoSearchSelect from '~/components/github/GitHubRepoSearchSelect.vue'
import RepoTreeBrowser from '~/components/github/RepoTreeBrowser.vue'
import GitHubDocUrlImport from '~/components/fragments/GitHubDocUrlImport.vue'

const props = withDefaults(
  defineProps<{
    kind: FragmentOwnerKind
    ownerId: string
    /** Account scope only: the workspace whose document-source connection to fetch through. */
    viaWorkspaceId?: string
    /** Whether to show the resolved/merged catalog tab (workspace scope only). */
    showCatalog?: boolean
  }>(),
  { showCatalog: false },
)

// The workspace scope follows the active board (singleton, shared with the navbar);
// the account scope uses an owner-keyed store so each account is isolated.
const library =
  props.kind === 'workspace'
    ? useFragmentLibraryStore()
    : useFragmentLibrary(props.kind, props.ownerId)
const documents = useDocumentsStore()
const github = useGitHubStore()
const toast = useToast()
const { t, d } = useI18n()
const { confirm } = useConfirm()

const isWorkspace = props.kind === 'workspace'
/** Linking a document at the account scope needs a workspace connection to fetch through. */
const docLinkDisabled = computed(() => props.kind === 'account' && !props.viaWorkspaceId)

watch(
  () => props.viaWorkspaceId,
  (id) => {
    library.viaWorkspaceId = id
  },
  { immediate: true },
)

watch(
  () => props.ownerId,
  () => {
    void library.probe()
    void documents.probe()
    // The GitHub pickers (repo search + tree browser) need the active board's
    // installation state; probe once so they light up when the App is connected.
    void github.probe()
  },
  { immediate: true },
)

// The rich GitHub pickers reuse the active board's App installation. When it isn't
// connected (or the integration is off) both forms fall back to manual text entry.
const githubReady = computed(() => github.available === true && github.connected)

type Tab = 'catalog' | 'authored' | 'documents' | 'sources'
const tabs = computed<Tab[]>(() =>
  props.showCatalog
    ? ['catalog', 'authored', 'documents', 'sources']
    : ['authored', 'documents', 'sources'],
)
const tab = ref<Tab>(props.showCatalog ? 'catalog' : 'authored')

const ownerLabel = computed(() =>
  isWorkspace ? t('fragments.owner.workspace') : t('fragments.owner.account'),
)

// Exhaustive tier→label map of literal `t(...)` keys (keeps the typed-key drift guard live).
const tierLabel = computed<Record<ResolvedFragment['tier'], string>>(() => ({
  builtin: t('fragments.tier.builtin'),
  account: t('fragments.tier.account'),
  workspace: t('fragments.tier.workspace'),
}))
// `as const` keeps the literal color names (assignable to UBadge's `color`
// union) instead of widening to `string`; `satisfies` still checks the shape.
const tierColor = {
  builtin: 'neutral',
  account: 'info',
  workspace: 'primary',
} as const satisfies Record<ResolvedFragment['tier'], string>

function tabLabel(which: Tab): string {
  if (which === 'catalog') return t('fragments.tab.catalog')
  if (which === 'authored') return ownerLabel.value
  if (which === 'documents') return t('fragments.tab.documents')
  return t('fragments.tab.sources')
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

// Per-row / per-form in-flight tracking. The store's single `library.loading` flag
// drove every row's button at once (UX-29) and cross-spun the add/link forms; key
// each async action so only the control that triggered it shows a spinner.
const busyRows = reactive(new Set<string>())
const rowBusy = (key: string) => busyRows.has(key)
async function withRow(key: string, fn: () => Promise<void>) {
  if (busyRows.has(key)) return
  busyRows.add(key)
  try {
    await fn()
  } finally {
    busyRows.delete(key)
  }
}
const creating = ref(false)
const linkingDoc = ref(false)
const linkingSource = ref(false)

// ---- create a hand-authored fragment --------------------------------------
const draft = ref({ title: '', summary: '', body: '', brief: '', tags: '' })
const draftValid = computed(
  () => draft.value.title.trim() && draft.value.summary.trim() && draft.value.body.trim(),
)

// ---- auto-generate a title from the fragment's content (inline LLM call) ---
// Shared by the create form and the inline editor; keyed so only the button that triggered it
// spins. Generation needs a body (the title is derived from it); the summary rides along.
const generatingTitleFor = ref<string | null>(null)
async function autofillTitle(
  key: string,
  get: () => { body: string; summary?: string },
  set: (title: string) => void,
) {
  const { body, summary } = get()
  if (!body.trim() || generatingTitleFor.value) return
  generatingTitleFor.value = key
  try {
    const title = await library.generateTitle({
      body: body.trim(),
      summary: summary?.trim() || undefined,
    })
    set(title)
  } catch (e) {
    notifyError(t('fragments.authored.titleGenFailed'), e)
  } finally {
    generatingTitleFor.value = null
  }
}

// ---- edit an existing hand-authored fragment (title / summary / body / tags) ---
const editDraft = ref<{
  id: string
  title: string
  summary: string
  body: string
  brief: string
  tags: string
} | null>(null)
function startEdit(f: (typeof library.fragments)[number]) {
  editDraft.value = {
    id: f.id,
    title: f.title,
    summary: f.summary,
    body: f.body,
    brief: f.brief ?? '',
    tags: (f.tags ?? []).join(', '),
  }
  showEditBrief.value = showOverrideField(uiMode.isAdvanced, f.brief ?? null)
}
function cancelEdit() {
  editDraft.value = null
}
const editValid = computed(
  () =>
    !!editDraft.value &&
    !!editDraft.value.title.trim() &&
    !!editDraft.value.summary.trim() &&
    !!editDraft.value.body.trim(),
)
// The linked SHORT VERSION is an OVERRIDE of what the platform does by default (condense a
// long standard automatically, fold a short one in full), so it follows the override rule:
// hidden in basic mode while unset, revealed as soon as the fragment carries one — a
// basic-mode curator is never left unable to see or clear a brief a teammate linked.
//
// Both flags are LATCHED at the moment the form opens rather than tracking the live draft.
// Recomputing per keystroke makes the control delete itself the instant a basic-mode curator
// empties it — mid-edit, under the cursor, on the one interaction (clearing, to hand the
// standard back to auto-generation) the rule exists to keep reachable.
const uiMode = useUiModeStore()
const showEditBrief = ref(false)
const showDraftBrief = computed(() => showOverrideField(uiMode.isAdvanced, null))

async function saveEdit() {
  const d = editDraft.value
  if (!d || !editValid.value) return
  await withRow(`edit:${d.id}`, async () => {
    try {
      await library.update(d.id, {
        title: d.title.trim(),
        summary: d.summary.trim(),
        body: d.body.trim(),
        // Always sent, so clearing the box UNLINKS the short version and hands the
        // standard back to auto-generation (an omitted key would leave the old one).
        brief: d.brief.trim(),
        tags: d.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      })
      editDraft.value = null
      toast.add({ title: t('fragments.toast.updated'), icon: 'i-lucide-check' })
    } catch (e) {
      notifyError(t('fragments.toast.updateFailed'), e)
    }
  })
}

async function createFragment() {
  if (!draftValid.value) return
  creating.value = true
  try {
    await library.create({
      title: draft.value.title.trim(),
      summary: draft.value.summary.trim(),
      body: draft.value.body.trim(),
      brief: draft.value.brief.trim() || undefined,
      tags: draft.value.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    })
    draft.value = { title: '', summary: '', body: '', brief: '', tags: '' }
    toast.add({ title: t('fragments.toast.added'), icon: 'i-lucide-check' })
  } catch (e) {
    notifyError(t('fragments.toast.addFailed'), e)
  } finally {
    creating.value = false
  }
}

async function removeFragment(id: string) {
  const name = library.fragments.find((f) => f.id === id)?.title ?? ''
  const ok = await confirm({
    title: t('fragments.confirmRemove.title'),
    description: t('fragments.confirmRemove.body', { name }),
    variant: 'destructive',
    confirmLabel: t('common.delete'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  await withRow(`remove:${id}`, async () => {
    try {
      await library.remove(id)
      toast.add({ title: t('fragments.toast.removed'), icon: 'i-lucide-trash-2' })
    } catch (e) {
      notifyError(t('fragments.toast.removeFailed'), e)
    }
  })
}

// ---- document-backed (living) fragments -----------------------------------
// Link a Confluence/Notion page or GitHub file as a fragment that is re-resolved
// from the source at run time (a living source of truth, not a frozen snapshot).
const docDraft = ref({ source: '' as DocumentSourceKind | '', ref: '', tags: '' })
const docDraftValid = computed(() => {
  if (docLinkDisabled.value || !docDraft.value.source) return false
  // The GitHub picker validates on staged files; every other path on the free-text ref.
  return usingDocPicker.value ? docFilePaths.value.length > 0 : !!docDraft.value.ref.trim()
})

// ---- GitHub file picker (documents tab) -----------------------------------
// For a GitHub source, let the user search a repo + browse to one or MORE files
// instead of hand-typing a `owner/repo:path` ref. Files are staged into a cart that
// spans folders (browsing away never drops earlier picks), and every staged file is
// linked as its own living fragment on submit. Only offered when the App/PAT is
// connected; other sources (Confluence/Notion) keep the single free-text ref field.
const isGithubDoc = computed(() => docDraft.value.source === 'github')
const showGithubDocPicker = computed(() => isGithubDoc.value && githubReady.value)
const docRepoId = ref<number | undefined>(undefined)
const docRepo = ref<GitHubAvailableRepo | undefined>(undefined)
// The staged files (repo-root-relative paths) for the selected repo. Multi-select so
// any number of files from any nesting level can be linked in one action.
const docFilePaths = ref<string[]>([])
// Where the tree browser opens (repo root by default); a pasted directory URL jumps it
// straight to the pasted folder so its files can be bulk-checked.
const docBrowsePath = ref('')

// Reset the picker (and the manual ref) whenever the selected source changes.
watch(
  () => docDraft.value.source,
  () => {
    docRepoId.value = undefined
    docRepo.value = undefined
    docFilePaths.value = []
    docBrowsePath.value = ''
    docDraft.value.ref = ''
  },
)

// A URL import wants the browser opened at the pasted folder in the SAME flush as its
// repo selection (so the tree loads once, at the right path); a manual repo switch
// wants the path reset instead. The import stages its target here for the watcher.
let pendingBrowsePath: string | null = null

// A new repo selection clears the previously-staged files (they were repo-scoped) and
// re-roots the browser (a folder from the previous repo has no meaning in the new one).
// When the repo is fully deselected, drop the cached repo too so no stale `docRepo`
// lingers behind a now-empty picker.
watch(docRepoId, (id) => {
  docFilePaths.value = []
  docBrowsePath.value = pendingBrowsePath ?? ''
  pendingBrowsePath = null
  if (id === undefined) docRepo.value = undefined
})

/** This tier's existing document-backed fragments. */
const documentFragments = computed(() => library.fragments.filter((f) => f.documentRef))

/** Add/remove a browsed file to/from the staged cart (the tree emits `toggle`). */
function toggleDocFile(path: string) {
  const clean = normalizeRepoPath(path)
  const i = docFilePaths.value.indexOf(clean)
  if (i >= 0) docFilePaths.value.splice(i, 1)
  else docFilePaths.value.push(clean)
}

/** Files of the selected repo already linked as fragments — shown "added"/not re-pickable. */
const docAddedPaths = computed<string[]>(() => {
  const repo = docRepo.value
  if (!repo) return []
  const prefix = `${repo.owner}/${repo.name}:`
  return documentFragments.value
    .filter(
      (f) => f.documentRef?.source === 'github' && f.documentRef.externalId.startsWith(prefix),
    )
    .map((f) => f.documentRef!.externalId.slice(prefix.length))
})

/** The canonical `owner/repo:path` refs for the staged files. */
const stagedDocRefs = computed(() =>
  docRepo.value
    ? docFilePaths.value.map((path) => ({
        path,
        ref: `${docRepo.value!.owner}/${docRepo.value!.name}:${path}`,
      }))
    : [],
)

/** When the rich picker drives the ref(s); otherwise the free-text field does. */
const usingDocPicker = computed(() => showGithubDocPicker.value)

/**
 * A pasted GitHub file/directory URL resolved to a repo + location: select the repo
 * (through the same refs the search select drives), then stage the file or jump the
 * tree browser to the directory for bulk checking. Staging waits a tick because the
 * `docRepoId` watcher clears the cart on a repo change.
 */
async function onDocUrlResolved(target: {
  repo: GitHubAvailableRepo
  path: string
  kind: 'file' | 'dir'
}) {
  const clean = normalizeRepoPath(target.path)
  // A file opens its parent folder (so the pick is visible in context); a dir opens itself.
  const browseDir =
    target.kind === 'dir'
      ? clean
      : clean.includes('/')
        ? clean.slice(0, clean.lastIndexOf('/'))
        : ''
  if (docRepoId.value !== target.repo.githubId) {
    pendingBrowsePath = browseDir
    docRepo.value = target.repo
    docRepoId.value = target.repo.githubId
    // Let the repo-change watcher run (clears the cart, applies the browse path)
    // before staging, or the staged file would be swept with the old repo's cart.
    await nextTick()
  } else {
    docBrowsePath.value = browseDir
  }
  if (target.kind === 'file' && clean) {
    if (!docFilePaths.value.includes(clean) && !docAddedPaths.value.includes(clean)) {
      docFilePaths.value.push(clean)
    }
  }
}

/**
 * The reason the "Link as living fragment" button is disabled, stated next to it —
 * an inert button with no explanation reads as broken. Null when the button is live
 * (or already busy linking).
 */
const docLinkBlockedReason = computed<string | null>(() => {
  if (linkingDoc.value || docDraftValid.value) return null
  if (!docDraft.value.source) return t('fragments.documents.blockedReason.noSource')
  if (usingDocPicker.value) {
    if (docRepoId.value === undefined) return t('fragments.documents.blockedReason.noRepo')
    return t('fragments.documents.blockedReason.noFiles')
  }
  if (!docDraft.value.ref.trim()) return t('fragments.documents.blockedReason.noRef')
  return null
})

async function linkDocumentFragment() {
  if (!docDraftValid.value) return
  linkingDoc.value = true
  try {
    const source = docDraft.value.source as DocumentSourceKind
    const tags = docDraft.value.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    if (!usingDocPicker.value) {
      // Free-text field: exactly one ref.
      await library.createDocumentFragment({ source, ref: docDraft.value.ref.trim(), tags })
      docDraft.value = { source: '', ref: '', tags: '' }
      toast.add({ title: t('fragments.toast.documentLinked'), icon: 'i-lucide-link' })
      return
    }

    // The picker stages many files (one fragment each). Link them serially — serial, not
    // parallel, so one bad ref can't be masked by a burst of concurrent failures — and drop
    // each from the cart the moment it succeeds. Every staged file is attempted even if an
    // earlier one fails, so a single unlinkable ref never blocks the rest: the successes are
    // linked and removed from the cart, and only the failures stay staged (with the first
    // error surfaced) so a retry re-attempts just those, never re-linking what already went in.
    let linked = 0
    let firstError: unknown
    for (const { path, ref } of stagedDocRefs.value) {
      try {
        await library.createDocumentFragment({ source, ref, tags })
        const i = docFilePaths.value.indexOf(path)
        if (i >= 0) docFilePaths.value.splice(i, 1)
        linked++
      } catch (e) {
        firstError ??= e
      }
    }
    if (linked > 0) {
      // A vue-i18n plural message (count as the plural choice) so Slavic few/many forms
      // render correctly, and the count==1 case reads naturally too.
      toast.add({
        title: t('fragments.toast.documentsLinked', { count: linked }, linked),
        icon: 'i-lucide-link',
      })
    }
    if (firstError) {
      notifyError(t('fragments.toast.linkDocumentFailed'), firstError)
    } else {
      // Everything staged linked — clear the whole draft (also resets repo/source selection).
      docDraft.value = { source: '', ref: '', tags: '' }
    }
  } catch (e) {
    notifyError(t('fragments.toast.linkDocumentFailed'), e)
  } finally {
    linkingDoc.value = false
  }
}

async function refreshFragment(id: string) {
  await withRow(`refresh:${id}`, async () => {
    try {
      await library.refreshDocumentFragment(id)
      toast.add({ title: t('fragments.toast.refreshed'), icon: 'i-lucide-refresh-cw' })
    } catch (e) {
      notifyError(t('fragments.toast.refreshFailed'), e)
    }
  })
}

// ---- repo sources ----------------------------------------------------------
// When the App is connected the user searches a repo + browses to the guideline
// directory; otherwise the manual owner/name/dir fields are the fallback.
const sourceRepoId = ref<number | undefined>(undefined)
const sourceRepo = ref<GitHubAvailableRepo | undefined>(undefined)
const sourceDir = ref<string | undefined>(undefined)
const sourceRef = ref('')
const manualSource = ref({ repoOwner: '', repoName: '', dirPath: '' })

// A new repo selection clears the previously-browsed directory.
watch(sourceRepoId, () => {
  sourceDir.value = undefined
})

const sourceOwnerName = computed<{ owner: string; name: string } | null>(() => {
  if (githubReady.value) {
    return sourceRepo.value ? { owner: sourceRepo.value.owner, name: sourceRepo.value.name } : null
  }
  const owner = manualSource.value.repoOwner.trim()
  const name = manualSource.value.repoName.trim()
  return owner && name ? { owner, name } : null
})
const sourceValid = computed(() => sourceOwnerName.value !== null)

function resetSourceDraft() {
  sourceRepoId.value = undefined
  sourceRepo.value = undefined
  sourceDir.value = undefined
  sourceRef.value = ''
  manualSource.value = { repoOwner: '', repoName: '', dirPath: '' }
}

async function linkSource() {
  const ownerName = sourceOwnerName.value
  if (!ownerName) return
  const dirPath =
    (githubReady.value ? sourceDir.value : manualSource.value.dirPath.trim()) || undefined
  linkingSource.value = true
  try {
    const source = await library.linkSource({
      repoOwner: ownerName.owner,
      repoName: ownerName.name,
      dirPath,
      gitRef: sourceRef.value.trim() || undefined,
    })
    resetSourceDraft()
    // Auto-sync the freshly-linked source via the store method directly (not the
    // `syncSource` row wrapper): a failure here should surface as a link failure, and
    // the form-level `linkingSource` spinner already covers the whole operation.
    await library.syncSource(source.id)
    toast.add({ title: t('fragments.toast.sourceLinked'), icon: 'i-lucide-git-branch' })
  } catch (e) {
    notifyError(t('fragments.toast.linkSourceFailed'), e)
  } finally {
    linkingSource.value = false
  }
}

async function syncSource(id: string) {
  await withRow(`sync:${id}`, async () => {
    try {
      const result = await library.syncSource(id)
      toast.add({
        title: t('fragments.toast.synced', {
          updated: result.upserted,
          removed: result.tombstoned,
        }),
        icon: 'i-lucide-refresh-cw',
        color: 'info',
      })
    } catch (e) {
      notifyError(t('fragments.toast.syncFailed'), e)
    }
  })
}

async function checkSource(id: string) {
  await withRow(`check:${id}`, async () => {
    try {
      const status = await library.checkSource(id)
      toast.add({
        title: status.changed
          ? t('fragments.toast.changesAvailable')
          : t('fragments.toast.upToDate'),
        icon: status.changed ? 'i-lucide-bell-dot' : 'i-lucide-check',
      })
    } catch (e) {
      notifyError(t('fragments.toast.checkSourceFailed'), e)
    }
  })
}

async function unlinkSource(id: string) {
  const source = library.sources.find((s) => s.id === id)
  const repo = source ? `${source.repoOwner}/${source.repoName}` : ''
  const ok = await confirm({
    title: t('fragments.confirmUnlinkSource.title'),
    description: t('fragments.confirmUnlinkSource.body', { repo }),
    variant: 'destructive',
    confirmLabel: t('fragments.confirmUnlinkSource.confirm'),
    icon: 'i-lucide-unplug',
  })
  if (!ok) return
  await withRow(`unlink:${id}`, async () => {
    try {
      await library.unlinkSource(id)
      toast.add({ title: t('fragments.toast.sourceUnlinked'), icon: 'i-lucide-unplug' })
    } catch (e) {
      notifyError(t('fragments.toast.unlinkSourceFailed'), e)
    }
  })
}
</script>

<template>
  <!-- Deliberately UNNAMED. This manager is mounted at two scopes (the board's library modal and
       the account settings' fragment tab), so a `data-testid` on its root would be one id over
       two elements. The tutorial tour's anchor is named by the WORKSPACE entry point instead —
       see `FragmentLibraryPanel.vue`. -->
  <div class="flex flex-col gap-4">
    <!-- The library is opt-out; if a deployment disabled it, don't offer forms that
         would fail with a raw 503 — say so instead (any entry point lands here). -->
    <div
      v-if="library.available === false"
      class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-400"
    >
      {{ t('fragments.unavailable') }}
    </div>

    <template v-else>
      <p class="text-sm text-slate-400">
        <template v-if="isWorkspace">
          {{ t('fragments.intro.workspace') }}
        </template>
        <template v-else>
          {{ t('fragments.intro.account') }}
        </template>
      </p>

      <div class="flex gap-2">
        <UButton
          v-for="t in tabs"
          :key="t"
          :color="tab === t ? 'primary' : 'neutral'"
          :variant="tab === t ? 'solid' : 'ghost'"
          size="sm"
          @click="
            () => {
              tab = t
            }
          "
        >
          {{ tabLabel(t) }}
        </UButton>
      </div>

      <!-- Resolved (merged) catalog — workspace scope only -->
      <div v-if="tab === 'catalog'" class="flex flex-col gap-2">
        <p class="text-xs text-slate-500">
          {{
            t(
              'fragments.catalog.summary',
              { count: library.resolved.length, builtin: library.builtinCount },
              library.resolved.length,
            )
          }}
        </p>
        <div
          v-for="f in library.resolved"
          :key="f.id"
          class="rounded-md border border-slate-800 bg-slate-900/60 p-3"
        >
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-100">{{ f.title }}</span>
            <UBadge size="xs" :color="tierColor[f.tier]" variant="subtle">
              {{ tierLabel[f.tier] }}
            </UBadge>
            <UBadge
              v-if="f.documentRef"
              size="xs"
              color="success"
              variant="subtle"
              icon="i-lucide-radio"
            >
              {{ t('fragments.catalog.live', { source: f.documentRef.source }) }}
            </UBadge>
            <span class="ms-auto font-mono text-[11px] text-slate-500">{{ f.id }}</span>
          </div>
          <p class="mt-1 text-sm text-slate-400">{{ f.summary }}</p>
          <div v-if="f.tags?.length" class="mt-1 flex flex-wrap gap-1">
            <UBadge v-for="tag in f.tags" :key="tag" size="xs" variant="outline" color="neutral">
              {{ tag }}
            </UBadge>
          </div>
        </div>
      </div>

      <!-- Hand-authored (this tier) -->
      <div v-else-if="tab === 'authored'" class="flex flex-col gap-3">
        <div
          v-for="f in library.fragments"
          :key="f.id"
          class="rounded-md border border-slate-800 bg-slate-900/60 p-3"
        >
          <!-- Inline editor (hand-authored fragments): title / summary / body / tags, with the
               same auto-generate-title button as the create form. -->
          <div v-if="editDraft && editDraft.id === f.id" class="flex flex-col gap-2">
            <div class="flex gap-2">
              <UInput
                v-model="editDraft.title"
                :placeholder="t('fragments.authored.titlePlaceholder')"
                class="flex-1"
              />
              <UButton
                icon="i-lucide-wand-2"
                size="sm"
                variant="outline"
                :disabled="!editDraft.body.trim()"
                :loading="generatingTitleFor === `edit:${f.id}`"
                :title="t('fragments.authored.generateTitleHint')"
                @click="
                  autofillTitle(
                    `edit:${f.id}`,
                    () => ({ body: editDraft!.body, summary: editDraft!.summary }),
                    (title) => {
                      if (editDraft) editDraft.title = title
                    },
                  )
                "
              >
                {{ t('fragments.authored.generateTitle') }}
              </UButton>
            </div>
            <UInput
              v-model="editDraft.summary"
              :placeholder="t('fragments.authored.summaryPlaceholder')"
            />
            <UTextarea
              v-model="editDraft.body"
              :placeholder="t('fragments.authored.bodyPlaceholder')"
              :rows="4"
            />
            <div v-if="showEditBrief" class="flex flex-col gap-1">
              <UTextarea
                v-model="editDraft.brief"
                :placeholder="t('fragments.authored.briefPlaceholder')"
                :rows="2"
              />
              <p class="text-xs text-slate-500">{{ t('fragments.authored.briefHint') }}</p>
            </div>
            <UInput
              v-model="editDraft.tags"
              :placeholder="t('fragments.authored.tagsPlaceholder')"
            />
            <div class="flex gap-2">
              <UButton
                size="sm"
                :disabled="!editValid"
                :loading="rowBusy(`edit:${f.id}`)"
                @click="saveEdit"
              >
                {{ t('common.save') }}
              </UButton>
              <UButton size="sm" variant="ghost" color="neutral" @click="cancelEdit">
                {{ t('common.cancel') }}
              </UButton>
            </div>
          </div>
          <!-- Row -->
          <div v-else class="flex items-start gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-medium text-slate-100">{{ f.title }}</span>
                <UBadge v-if="f.source" size="xs" color="info" variant="subtle">{{
                  t('fragments.authored.fromRepo')
                }}</UBadge>
              </div>
              <p class="text-sm text-slate-400">{{ f.summary }}</p>
            </div>
            <div class="ms-auto flex gap-1">
              <!-- Editing a repo-SOURCED fragment locally would be overwritten on the next sync,
                   so only hand-authored fragments are editable here. -->
              <UButton
                v-if="!f.source"
                icon="i-lucide-pencil"
                size="xs"
                variant="ghost"
                :title="t('common.edit')"
                @click="startEdit(f)"
              />
              <UButton
                icon="i-lucide-trash-2"
                size="xs"
                color="error"
                variant="ghost"
                :loading="rowBusy(`remove:${f.id}`)"
                @click="removeFragment(f.id)"
              />
            </div>
          </div>
        </div>
        <p v-if="!library.fragments.length" class="text-sm text-slate-500">
          {{
            isWorkspace
              ? t('fragments.authored.empty.workspace')
              : t('fragments.authored.empty.account')
          }}
        </p>

        <div class="rounded-md border border-slate-800 p-3">
          <p class="mb-2 text-sm font-medium">{{ t('fragments.authored.addTitle') }}</p>
          <div class="flex flex-col gap-2">
            <div class="flex gap-2">
              <UInput
                v-model="draft.title"
                :placeholder="t('fragments.authored.titlePlaceholder')"
                class="flex-1"
              />
              <UButton
                icon="i-lucide-wand-2"
                size="sm"
                variant="outline"
                :disabled="!draft.body.trim()"
                :loading="generatingTitleFor === 'create'"
                :title="t('fragments.authored.generateTitleHint')"
                data-testid="fragment-generate-title"
                @click="
                  autofillTitle(
                    'create',
                    () => ({ body: draft.body, summary: draft.summary }),
                    (title) => {
                      draft.title = title
                    },
                  )
                "
              >
                {{ t('fragments.authored.generateTitle') }}
              </UButton>
            </div>
            <UInput
              v-model="draft.summary"
              :placeholder="t('fragments.authored.summaryPlaceholder')"
            />
            <UTextarea
              v-model="draft.body"
              :placeholder="t('fragments.authored.bodyPlaceholder')"
              :rows="4"
            />
            <div v-if="showDraftBrief" class="flex flex-col gap-1">
              <UTextarea
                v-model="draft.brief"
                :placeholder="t('fragments.authored.briefPlaceholder')"
                :rows="2"
              />
              <p class="text-xs text-slate-500">{{ t('fragments.authored.briefHint') }}</p>
            </div>
            <UInput v-model="draft.tags" :placeholder="t('fragments.authored.tagsPlaceholder')" />
            <UButton
              icon="i-lucide-plus"
              size="sm"
              :disabled="!draftValid"
              :loading="creating"
              class="self-start"
              @click="createFragment"
            >
              {{ t('fragments.authored.add') }}
            </UButton>
          </div>
        </div>
      </div>

      <!-- Document-backed (living) fragments -->
      <div v-else-if="tab === 'documents'" class="flex flex-col gap-3">
        <p class="text-xs text-slate-500">
          {{ t('fragments.documents.intro') }}
        </p>

        <div
          v-for="f in documentFragments"
          :key="f.id"
          class="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-3"
        >
          <UIcon name="i-lucide-radio" class="mt-0.5 h-4 w-4 text-emerald-400" />
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium text-slate-100">{{ f.title }}</span>
              <UBadge size="xs" color="success" variant="subtle">
                {{ f.documentRef?.source }}
              </UBadge>
            </div>
            <p class="text-sm text-slate-400">{{ f.summary }}</p>
            <p v-if="f.resolvedAt" class="text-[11px] text-slate-500">
              {{
                t('fragments.documents.lastResolved', { date: d(new Date(f.resolvedAt), 'long') })
              }}
            </p>
          </div>
          <div class="ms-auto flex gap-1">
            <UButton
              icon="i-lucide-refresh-cw"
              size="xs"
              variant="ghost"
              :loading="rowBusy(`refresh:${f.id}`)"
              :title="t('fragments.documents.refreshTitle')"
              @click="refreshFragment(f.id)"
            />
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="error"
              variant="ghost"
              :loading="rowBusy(`remove:${f.id}`)"
              @click="removeFragment(f.id)"
            />
          </div>
        </div>
        <p v-if="!documentFragments.length" class="text-sm text-slate-500">
          {{ t('fragments.documents.empty') }}
        </p>

        <div class="rounded-md border border-slate-800 p-3">
          <p class="mb-2 text-sm font-medium">{{ t('fragments.documents.linkTitle') }}</p>
          <div v-if="docLinkDisabled" class="text-sm text-slate-500">
            {{ t('fragments.documents.disabledHint') }}
          </div>
          <div v-else-if="!documents.connectedSources.length" class="text-sm text-slate-500">
            {{ t('fragments.documents.connectFirst') }}
          </div>
          <div v-else class="flex flex-col gap-2">
            <div class="flex flex-wrap gap-2">
              <UButton
                v-for="s in documents.connectedSources"
                :key="s.source"
                size="xs"
                :color="docDraft.source === s.source ? 'primary' : 'neutral'"
                :variant="docDraft.source === s.source ? 'solid' : 'outline'"
                @click="
                  () => {
                    docDraft.source = s.source
                  }
                "
              >
                {{ s.label }}
              </UButton>
            </div>

            <!-- GitHub: paste a file/directory URL, or search a repo + browse to one or
                 more files, instead of typing the ref -->
            <template v-if="showGithubDocPicker">
              <GitHubDocUrlImport @resolved="onDocUrlResolved" />
              <GitHubRepoSearchSelect v-model="docRepoId" @update:repo="docRepo = $event" />
              <div
                v-if="docRepoId !== undefined"
                class="rounded-md border border-slate-800 bg-slate-900/40 p-2"
              >
                <p class="mb-2 text-xs text-slate-400">
                  {{ t('fragments.documents.githubBrowseHint') }}
                </p>
                <RepoTreeBrowser
                  :repo-github-id="docRepoId"
                  mode="file"
                  multiple
                  :start-path="docBrowsePath"
                  :selected-paths="docFilePaths"
                  :added-paths="docAddedPaths"
                  @toggle="toggleDocFile"
                />
                <div v-if="stagedDocRefs.length" class="mt-2 space-y-1">
                  <p class="text-xs font-medium text-slate-400">
                    {{ t('fragments.documents.selectedFiles', { count: stagedDocRefs.length }) }}
                  </p>
                  <div
                    v-for="staged in stagedDocRefs"
                    :key="staged.path"
                    class="flex items-center gap-1.5 rounded bg-slate-800/60 px-2 py-1 text-xs text-slate-300"
                  >
                    <UIcon
                      name="i-lucide-file-code-2"
                      class="h-3.5 w-3.5 shrink-0 text-indigo-400"
                    />
                    <span class="truncate">{{ staged.path }}</span>
                    <UButton
                      class="ms-auto"
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      icon="i-lucide-x"
                      :aria-label="t('fragments.documents.removeFile')"
                      @click="toggleDocFile(staged.path)"
                    />
                  </div>
                </div>
              </div>
            </template>

            <UInput
              v-if="!usingDocPicker"
              v-model="docDraft.ref"
              :placeholder="t('fragments.documents.refPlaceholder')"
            />
            <UInput
              v-model="docDraft.tags"
              :placeholder="t('fragments.documents.tagsPlaceholder')"
            />
            <div class="flex items-center gap-2 self-start">
              <UButton
                icon="i-lucide-link"
                size="sm"
                :disabled="!docDraftValid"
                :loading="linkingDoc"
                data-testid="fragment-link-document"
                @click="linkDocumentFragment"
              >
                {{ t('fragments.documents.link') }}
              </UButton>
              <p
                v-if="docLinkBlockedReason"
                class="flex items-center gap-1 text-xs text-slate-500"
                data-testid="fragment-link-blocked-reason"
              >
                <UIcon name="i-lucide-info" class="h-3.5 w-3.5 shrink-0" />
                {{ docLinkBlockedReason }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Repo sources -->
      <div v-else class="flex flex-col gap-3">
        <div
          v-for="s in library.sources"
          :key="s.id"
          class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-3"
        >
          <UIcon name="i-lucide-git-branch" class="h-4 w-4 text-slate-400" />
          <div class="min-w-0">
            <span class="font-mono text-sm text-slate-100">
              {{ s.repoOwner }}/{{ s.repoName
              }}<span class="text-slate-500">/{{ s.dirPath || '' }}</span>
            </span>
            <p class="text-xs text-slate-500">
              {{
                s.lastSyncedAt
                  ? t('fragments.sources.metaSynced', { ref: s.gitRef })
                  : t('fragments.sources.metaNever', { ref: s.gitRef })
              }}
            </p>
          </div>
          <UBadge
            v-if="library.sourceChanges[s.id]"
            size="xs"
            color="warning"
            variant="subtle"
            class="ms-auto"
          >
            {{ t('fragments.sources.changes') }}
          </UBadge>
          <div class="ms-auto flex gap-1">
            <UButton
              icon="i-lucide-search-check"
              size="xs"
              variant="ghost"
              :loading="rowBusy(`check:${s.id}`)"
              @click="checkSource(s.id)"
            />
            <UButton
              icon="i-lucide-refresh-cw"
              size="xs"
              variant="ghost"
              :loading="rowBusy(`sync:${s.id}`)"
              @click="syncSource(s.id)"
            />
            <UButton
              icon="i-lucide-unplug"
              size="xs"
              color="error"
              variant="ghost"
              :loading="rowBusy(`unlink:${s.id}`)"
              @click="unlinkSource(s.id)"
            />
          </div>
        </div>
        <p v-if="!library.sources.length" class="text-sm text-slate-500">
          {{ t('fragments.sources.empty') }}
        </p>

        <div class="rounded-md border border-slate-800 p-3">
          <p class="mb-2 text-sm font-medium">{{ t('fragments.sources.linkTitle') }}</p>
          <div class="flex flex-col gap-2">
            <!-- Connected: search a repo + browse to the guideline directory -->
            <template v-if="githubReady">
              <GitHubRepoSearchSelect v-model="sourceRepoId" @update:repo="sourceRepo = $event" />
              <div
                v-if="sourceRepoId !== undefined"
                class="rounded-md border border-slate-800 bg-slate-900/40 p-2"
              >
                <p class="mb-2 text-xs text-slate-400">
                  {{ t('fragments.sources.browseHint') }}
                </p>
                <RepoTreeBrowser v-model="sourceDir" :repo-github-id="sourceRepoId" mode="dir" />
                <p class="mt-2 truncate text-xs text-slate-400">
                  <template v-if="sourceDir">
                    {{ t('fragments.sources.selectedDir') }}
                    <code class="text-slate-200">{{ sourceDir }}</code>
                  </template>
                  <template v-else>{{ t('fragments.sources.wholeRepo') }}</template>
                </p>
              </div>
            </template>

            <!-- Not connected: manual owner/name/dir fallback -->
            <template v-else>
              <div class="flex gap-2">
                <UInput
                  v-model="manualSource.repoOwner"
                  :placeholder="t('fragments.sources.ownerPlaceholder')"
                  class="flex-1"
                />
                <UInput
                  v-model="manualSource.repoName"
                  :placeholder="t('fragments.sources.repoPlaceholder')"
                  class="flex-1"
                />
              </div>
              <UInput
                v-model="manualSource.dirPath"
                :placeholder="t('fragments.sources.dirPlaceholder')"
              />
            </template>

            <UInput v-model="sourceRef" :placeholder="t('fragments.sources.refPlaceholder')" />
            <UButton
              icon="i-lucide-link"
              size="sm"
              :disabled="!sourceValid"
              :loading="linkingSource"
              class="self-start"
              @click="linkSource"
            >
              {{ t('fragments.sources.link') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
