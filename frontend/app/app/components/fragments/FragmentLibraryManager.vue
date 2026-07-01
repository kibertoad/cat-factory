<script setup lang="ts">
// Prompt-fragment library manager (ADR 0006), reused at two scopes: a board
// (`workspace`) and an `account`. Curate hand-authored fragments, link external
// documents as living fragments, link repos of Markdown guidelines (with a
// "changes available" badge + resync), and — at the workspace scope only — review
// the merged catalog (built-in ∪ account ∪ workspace) an agent is selected from per
// run. The account scope has no resolved/merged catalog and fetches document
// fragments through `viaWorkspaceId` (document-source credentials are per-workspace).
import { computed, ref, watch } from 'vue'
import type { DocumentSourceKind, FragmentOwnerKind, ResolvedFragment } from '~/types/domain'
import { useFragmentLibrary, useFragmentLibraryStore } from '~/stores/fragmentLibrary'

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
  },
  { immediate: true },
)

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

// ---- create a hand-authored fragment --------------------------------------
const draft = ref({ title: '', summary: '', body: '', tags: '' })
const draftValid = computed(
  () => draft.value.title.trim() && draft.value.summary.trim() && draft.value.body.trim(),
)

async function createFragment() {
  if (!draftValid.value) return
  try {
    await library.create({
      title: draft.value.title.trim(),
      summary: draft.value.summary.trim(),
      body: draft.value.body.trim(),
      tags: draft.value.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    })
    draft.value = { title: '', summary: '', body: '', tags: '' }
    toast.add({ title: t('fragments.toast.added'), icon: 'i-lucide-check' })
  } catch (e) {
    notifyError(t('fragments.toast.addFailed'), e)
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
  try {
    await library.remove(id)
    toast.add({ title: t('fragments.toast.removed'), icon: 'i-lucide-trash-2' })
  } catch (e) {
    notifyError(t('fragments.toast.removeFailed'), e)
  }
}

// ---- document-backed (living) fragments -----------------------------------
// Link a Confluence/Notion page or GitHub file as a fragment that is re-resolved
// from the source at run time (a living source of truth, not a frozen snapshot).
const docDraft = ref({ source: '' as DocumentSourceKind | '', ref: '', tags: '' })
const docDraftValid = computed(
  () => !docLinkDisabled.value && docDraft.value.source && docDraft.value.ref.trim(),
)

/** This tier's existing document-backed fragments. */
const documentFragments = computed(() => library.fragments.filter((f) => f.documentRef))

async function linkDocumentFragment() {
  if (!docDraftValid.value) return
  try {
    await library.createDocumentFragment({
      source: docDraft.value.source as DocumentSourceKind,
      ref: docDraft.value.ref.trim(),
      tags: docDraft.value.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    })
    docDraft.value = { source: '', ref: '', tags: '' }
    toast.add({ title: t('fragments.toast.documentLinked'), icon: 'i-lucide-link' })
  } catch (e) {
    notifyError(t('fragments.toast.linkDocumentFailed'), e)
  }
}

async function refreshFragment(id: string) {
  try {
    await library.refreshDocumentFragment(id)
    toast.add({ title: t('fragments.toast.refreshed'), icon: 'i-lucide-refresh-cw' })
  } catch (e) {
    notifyError(t('fragments.toast.refreshFailed'), e)
  }
}

// ---- repo sources ----------------------------------------------------------
const sourceDraft = ref({ repoOwner: '', repoName: '', dirPath: '', gitRef: '' })
const sourceValid = computed(
  () => sourceDraft.value.repoOwner.trim() && sourceDraft.value.repoName.trim(),
)

async function linkSource() {
  if (!sourceValid.value) return
  try {
    const source = await library.linkSource({
      repoOwner: sourceDraft.value.repoOwner.trim(),
      repoName: sourceDraft.value.repoName.trim(),
      dirPath: sourceDraft.value.dirPath.trim() || undefined,
      gitRef: sourceDraft.value.gitRef.trim() || undefined,
    })
    sourceDraft.value = { repoOwner: '', repoName: '', dirPath: '', gitRef: '' }
    await library.syncSource(source.id)
    toast.add({ title: t('fragments.toast.sourceLinked'), icon: 'i-lucide-git-branch' })
  } catch (e) {
    notifyError(t('fragments.toast.linkSourceFailed'), e)
  }
}

async function syncSource(id: string) {
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
}

async function checkSource(id: string) {
  try {
    const status = await library.checkSource(id)
    toast.add({
      title: status.changed
        ? t('fragments.toast.changesAvailable', { count: status.changedCount }, status.changedCount)
        : t('fragments.toast.upToDate'),
      icon: status.changed ? 'i-lucide-bell-dot' : 'i-lucide-check',
    })
  } catch (e) {
    notifyError(t('fragments.toast.checkSourceFailed'), e)
  }
}

async function unlinkSource(id: string) {
  try {
    await library.unlinkSource(id)
    toast.add({ title: t('fragments.toast.sourceUnlinked'), icon: 'i-lucide-unplug' })
  } catch (e) {
    notifyError(t('fragments.toast.unlinkSourceFailed'), e)
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
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
        @click="tab = t"
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
        class="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-3"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-medium text-slate-100">{{ f.title }}</span>
            <UBadge v-if="f.source" size="xs" color="info" variant="subtle">{{
              t('fragments.authored.fromRepo')
            }}</UBadge>
          </div>
          <p class="text-sm text-slate-400">{{ f.summary }}</p>
        </div>
        <UButton
          icon="i-lucide-trash-2"
          size="xs"
          color="error"
          variant="ghost"
          class="ms-auto"
          @click="removeFragment(f.id)"
        />
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
          <UInput v-model="draft.title" :placeholder="t('fragments.authored.titlePlaceholder')" />
          <UInput
            v-model="draft.summary"
            :placeholder="t('fragments.authored.summaryPlaceholder')"
          />
          <UTextarea
            v-model="draft.body"
            :placeholder="t('fragments.authored.bodyPlaceholder')"
            :rows="4"
          />
          <UInput v-model="draft.tags" :placeholder="t('fragments.authored.tagsPlaceholder')" />
          <UButton
            icon="i-lucide-plus"
            size="sm"
            :disabled="!draftValid"
            :loading="library.loading"
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
            {{ t('fragments.documents.lastResolved', { date: d(new Date(f.resolvedAt), 'long') }) }}
          </p>
        </div>
        <div class="ms-auto flex gap-1">
          <UButton
            icon="i-lucide-refresh-cw"
            size="xs"
            variant="ghost"
            :loading="library.loading"
            :title="t('fragments.documents.refreshTitle')"
            @click="refreshFragment(f.id)"
          />
          <UButton
            icon="i-lucide-trash-2"
            size="xs"
            color="error"
            variant="ghost"
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
              @click="docDraft.source = s.source"
            >
              {{ s.label }}
            </UButton>
          </div>
          <UInput v-model="docDraft.ref" :placeholder="t('fragments.documents.refPlaceholder')" />
          <UInput v-model="docDraft.tags" :placeholder="t('fragments.documents.tagsPlaceholder')" />
          <UButton
            icon="i-lucide-link"
            size="sm"
            :disabled="!docDraftValid"
            :loading="library.loading"
            class="self-start"
            @click="linkDocumentFragment"
          >
            {{ t('fragments.documents.link') }}
          </UButton>
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
          {{
            t(
              'fragments.sources.changes',
              { count: library.sourceChanges[s.id] },
              library.sourceChanges[s.id] ?? 0,
            )
          }}
        </UBadge>
        <div class="ms-auto flex gap-1">
          <UButton
            icon="i-lucide-search-check"
            size="xs"
            variant="ghost"
            @click="checkSource(s.id)"
          />
          <UButton
            icon="i-lucide-refresh-cw"
            size="xs"
            variant="ghost"
            :loading="library.loading"
            @click="syncSource(s.id)"
          />
          <UButton
            icon="i-lucide-unplug"
            size="xs"
            color="error"
            variant="ghost"
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
          <div class="flex gap-2">
            <UInput
              v-model="sourceDraft.repoOwner"
              :placeholder="t('fragments.sources.ownerPlaceholder')"
              class="flex-1"
            />
            <UInput
              v-model="sourceDraft.repoName"
              :placeholder="t('fragments.sources.repoPlaceholder')"
              class="flex-1"
            />
          </div>
          <div class="flex gap-2">
            <UInput
              v-model="sourceDraft.dirPath"
              :placeholder="t('fragments.sources.dirPlaceholder')"
              class="flex-1"
            />
            <UInput
              v-model="sourceDraft.gitRef"
              :placeholder="t('fragments.sources.refPlaceholder')"
              class="flex-1"
            />
          </div>
          <UButton
            icon="i-lucide-link"
            size="sm"
            :disabled="!sourceValid"
            :loading="library.loading"
            class="self-start"
            @click="linkSource"
          >
            {{ t('fragments.sources.link') }}
          </UButton>
        </div>
      </div>
    </div>
  </div>
</template>
