<script setup lang="ts">
// Stage external context (imported documents and tracker issues) for a board block that does not
// exist yet. Extracted verbatim from AddTaskModal so the initiative create flow gets the identical
// affordance rather than a second, drifting copy — the two are the same UI over the same
// `PendingContext` model, and only the guidance copy differs (hence the hint props).
//
// STAGED, not live: linking needs a block id, so picks are held here and committed by the host
// once the block exists (`useContextLinking().linkPending`). The inspector's own panels are the
// live counterpart, for a block that already exists.
//
// Attaching is ungated in both sections: when the relevant integration isn't connected the Attach
// button becomes a "Connect a source" action instead of vanishing, so the capability is
// discoverable. Connecting opens the source's connect modal OVER the host modal (both are
// root-mounted with independent open flags), so in-progress form data survives. That upgrade is
// itself gated on `integrations.manage` for documents, whose ATTACH writes are member-tier while
// storing the credential is not.
import { refDebounced } from '@vueuse/core'
import type { DocumentSourceKind } from '~/types/domain'
import type { PendingContext } from '~/composables/useContextLinking'
import { claimCandidates, firstLinkCandidate } from '~/components/context/pastedLinkOffer.logic'
import { connectableSources } from '~/utils/sourcePicker'
import ContextDocumentPicker from '~/components/documents/ContextDocumentPicker.vue'
import ContextIssuePicker from '~/components/tasks/ContextIssuePicker.vue'

const props = defineProps<{
  /** The staged attachments; the host owns the array and commits it after creating the block. */
  modelValue: PendingContext[]
  /** Why attaching a document helps HERE — the one thing that differs between hosts. */
  docsHint: string
  /** Why attaching an issue helps HERE. */
  issuesHint: string
  /**
   * The block the issue search is scoped to (the task's container / the initiative's service
   * frame). REQUIRED by ContextIssuePicker: it is what confines a GitHub search to that
   * service's linked repo, so there is no unscoped mode to fall back on.
   */
  scopeBlockId: string
  /**
   * The description the author is writing, watched for a pasted link worth attaching. Optional:
   * a host with no description field simply never offers.
   */
  description?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [PendingContext[]] }>()

const ui = useUiStore()
const documents = useDocumentsStore()
const tasks = useTasksStore()
const { t } = useI18n()

const docsConnected = computed(() => documents.available && documents.anyConnected)
const issuesConnected = computed(() => tasks.available && tasks.anyOffered)

// Sources the user could connect right now to unlock the picker, when none is connected yet: for
// documents, every configured source without a live connection (GitHub docs are already implicitly
// connected via the App, so they never appear here); for issues, every configured tracker not yet
// available. The connect modals are the same ones the Integrations hub opens.
//
// The document half goes through the shared `connectableSources`, the ONE answer to "which document
// sources could I connect", which the picker's own add tier reads too: as three near-copies these
// disagreed about whether an unavailable integration counted.
const { canManageIntegrations } = useWorkspaceAccess()
const connectableDocSources = computed(() =>
  connectableSources(documents.sources, {
    isConnected: documents.isConnected,
    canConnect: canManageIntegrations.value,
    available: documents.available,
  }),
)
const connectableIssueSources = computed(() =>
  tasks.available ? tasks.sources.filter((s) => !s.available) : [],
)
const connectDocMenu = computed(() => [
  connectableDocSources.value.map((s) => ({
    label: s.label,
    icon: s.icon,
    onSelect: () => ui.openDocumentConnect(s.source),
  })),
])
const connectIssueMenu = computed(() => [
  connectableIssueSources.value.map((s) => ({
    label: s.label,
    icon: s.icon,
    onSelect: () => ui.openTaskConnect(s.source),
  })),
])

const pendingDocs = computed(() => props.modelValue.filter((c) => c.kind === 'document'))
const pendingIssues = computed(() => props.modelValue.filter((c) => c.kind === 'task'))

// Context is picked through an inline search picker rather than a dropdown that opens a second,
// page-level modal: stacked page-level modals don't interact, so such a menu appears to open
// something with nothing clickable. The "Attach" button toggles the relevant picker open.
const showDocPicker = ref(false)
const chosenDocKeys = computed(() => pendingDocs.value.map(contextKey))
const showIssuePicker = ref(false)
const chosenIssueKeys = computed(() => pendingIssues.value.map(contextKey))

// ---- the pasted-link offer ------------------------------------------------------------------
// A URL named in a description already reaches the run path, where an UNIMPORTED one is dropped
// with an info line and the agent gets nothing from it. Offering to attach it here turns that
// silent drop into a decision the author can still make. Only HOST-PINNED sources are asked
// (`claimCandidates`), because a host-blind parser claims a shape rather than a reference.
const offer = ref<{ url: string; source: DocumentSourceKind; externalId: string } | null>(null)
/** The URL last resolved, so re-typing around an unchanged link costs no further round trips. */
let judged: string | null = null
/**
 * Which link-resolution pass is the current one. A pass that has been superseded neither writes an
 * offer nor spends another request.
 *
 * `judged` alone cannot do this: it is set BEFORE the awaits, so it stops a second pass starting
 * for the same URL but says nothing about a pass already in flight for a DIFFERENT one. The
 * description is a text field a person is still typing in, and the debounce releases a new pass
 * every 500ms, so an earlier URL's resolve routinely settles after a later one. Landing it would
 * offer to attach a link that is no longer in the description at all, and accepting the offer
 * attaches that wrong document, silently: the chip it adds names the stale URL, which is the only
 * place the mismatch is visible and the one part nobody re-reads.
 */
let offerPass = 0

// Debounced, because this fires on every keystroke of a description and each miss costs one
// request per connected host-pinned source.
const debouncedDescription = refDebounced(
  computed(() => props.description ?? ''),
  500,
)

watch(
  debouncedDescription,
  async (text) => {
    const url = firstLinkCandidate(text)
    if (url === judged) return
    const pass = ++offerPass
    judged = url
    offer.value = null
    if (!url || !documents.available) return
    for (const source of claimCandidates(documents.connectedSources.map((s) => s.source))) {
      // Checked per source, not just around the write: once superseded, the remaining sources
      // would be asked about a URL nobody is looking at any more.
      if (pass !== offerPass) return
      try {
        const ref = await documents.resolveRef(source, url)
        if (pass !== offerPass) return
        offer.value = { url, source, externalId: ref.externalId }
        return
      } catch {
        // silent-catch-ok: a source that refuses (or cannot be reached) simply makes no offer.
        // There is nothing to report — the paste stays in the description exactly as typed, and
        // the attach picker above is the route for anything this could not judge.
      }
    }
  },
  { immediate: true },
)

/** Stage the offered link, then withdraw the offer: it is now a chip in the list below. */
function acceptOffer() {
  const accepted = offer.value
  if (!accepted) return
  const descriptor = documents.descriptorFor(accepted.source)
  addPending({
    kind: 'document',
    source: accepted.source,
    externalId: accepted.externalId,
    title: accepted.url,
    subtitle: descriptor?.label,
    icon: descriptor?.icon,
    needsImport: true,
  })
  offer.value = null
}

function addPending(item: PendingContext) {
  if (props.modelValue.some((c) => contextKey(c) === contextKey(item))) return
  emit('update:modelValue', [...props.modelValue, item])
}
function removePending(item: PendingContext) {
  emit(
    'update:modelValue',
    props.modelValue.filter((c) => contextKey(c) !== contextKey(item)),
  )
}
</script>

<template>
  <div class="space-y-4">
    <!-- Context documents (ungated; Attach disabled until a source is connected). -->
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('contextAttachments.documents') }}
        </span>
        <UButton
          v-if="docsConnected"
          color="neutral"
          variant="soft"
          size="xs"
          :icon="showDocPicker ? 'i-lucide-x' : 'i-lucide-plus'"
          @click="
            () => {
              showDocPicker = !showDocPicker
            }
          "
        >
          {{ showDocPicker ? t('contextAttachments.done') : t('contextAttachments.attach') }}
        </UButton>
        <UDropdownMenu
          v-else-if="connectableDocSources.length > 1"
          :items="connectDocMenu"
          :content="{ side: 'bottom', align: 'end' }"
        >
          <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plug">
            {{ t('contextAttachments.connectSource') }}
          </UButton>
        </UDropdownMenu>
        <UButton
          v-else-if="connectableDocSources.length === 1"
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-plug"
          @click="ui.openDocumentConnect(connectableDocSources[0]!.source)"
        >
          {{
            t('contextAttachments.connectSourceNamed', { source: connectableDocSources[0]!.label })
          }}
        </UButton>
        <UButton
          v-else
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-plus"
          disabled
          :title="
            documents.available
              ? t('contextAttachments.attachDocDisabledConnect')
              : t('contextAttachments.attachDocDisabledEnable')
          "
        >
          {{ t('contextAttachments.attach') }}
        </UButton>
      </div>
      <!-- Offered, never applied: the author wrote the link into prose, and silently turning
           that into an attachment would attach pages nobody meant to attach. -->
      <div
        v-if="offer && docsConnected"
        class="flex items-center gap-2 rounded-md border border-indigo-900/60 bg-indigo-950/30 px-2 py-1.5"
        data-testid="pasted-link-offer"
      >
        <UIcon name="i-lucide-link" class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
        <span class="min-w-0 flex-1 truncate text-xs text-slate-300">
          {{
            t('contextAttachments.pastedLink.offer', {
              source: documents.descriptorFor(offer.source)?.label ?? offer.source,
            })
          }}
        </span>
        <UButton color="primary" variant="soft" size="xs" @click="acceptOffer">
          {{ t('contextAttachments.pastedLink.attach') }}
        </UButton>
      </div>

      <ContextDocumentPicker
        v-if="showDocPicker && docsConnected"
        :chosen-keys="chosenDocKeys"
        @pick="addPending"
      />
      <div v-if="pendingDocs.length" class="space-y-1">
        <div
          v-for="item in pendingDocs"
          :key="contextKey(item)"
          class="rounded-md border border-slate-800 bg-slate-900/60"
        >
          <div class="flex items-center gap-1.5 px-2 py-1.5 text-xs text-slate-300">
            <UIcon
              :name="item.icon ?? 'i-lucide-file-text'"
              class="h-3.5 w-3.5 shrink-0 text-indigo-400"
            />
            <span class="truncate">{{ item.title }}</span>
            <UBadge
              v-if="item.needsImport"
              color="neutral"
              variant="soft"
              size="xs"
              class="ms-1 shrink-0"
            >
              {{ t('contextAttachments.importsOnAdd') }}
            </UBadge>
            <button
              type="button"
              class="ms-auto shrink-0 text-slate-400 hover:text-slate-200"
              @click="removePending(item)"
            >
              <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />
            </button>
          </div>
          <p
            v-if="item.unreadable"
            class="px-2 pb-1.5 text-[11px] text-amber-400"
            data-testid="context-item-unreadable"
          >
            {{ t('contextAttachments.unreadable', { error: item.unreadable }) }}
          </p>
        </div>
      </div>
      <p v-else class="text-[11px] text-slate-500">
        {{ docsHint }}
      </p>
    </div>

    <!-- Context issues (ungated; Attach disabled until a tracker is connected). -->
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ t('contextAttachments.issues') }}
        </span>
        <UButton
          v-if="issuesConnected"
          color="neutral"
          variant="soft"
          size="xs"
          :icon="showIssuePicker ? 'i-lucide-x' : 'i-lucide-plus'"
          @click="
            () => {
              showIssuePicker = !showIssuePicker
            }
          "
        >
          {{ showIssuePicker ? t('contextAttachments.done') : t('contextAttachments.attach') }}
        </UButton>
        <UDropdownMenu
          v-else-if="connectableIssueSources.length > 1"
          :items="connectIssueMenu"
          :content="{ side: 'bottom', align: 'end' }"
        >
          <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plug">
            {{ t('contextAttachments.connectSource') }}
          </UButton>
        </UDropdownMenu>
        <UButton
          v-else-if="connectableIssueSources.length === 1"
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-plug"
          @click="ui.openTaskConnect(connectableIssueSources[0]!.source)"
        >
          {{
            t('contextAttachments.connectSourceNamed', {
              source: connectableIssueSources[0]!.label,
            })
          }}
        </UButton>
        <UButton
          v-else
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-plus"
          disabled
          :title="
            tasks.available
              ? t('contextAttachments.attachIssueDisabledConnect')
              : t('contextAttachments.attachIssueDisabledEnable')
          "
        >
          {{ t('contextAttachments.attach') }}
        </UButton>
      </div>
      <ContextIssuePicker
        v-if="showIssuePicker && issuesConnected"
        :chosen-keys="chosenIssueKeys"
        :scope-block-id="scopeBlockId"
        @pick="addPending"
      />
      <div v-if="pendingIssues.length" class="space-y-1">
        <div
          v-for="item in pendingIssues"
          :key="contextKey(item)"
          class="rounded-md border border-slate-800 bg-slate-900/60"
        >
          <div class="flex items-center gap-1.5 px-2 py-1.5 text-xs text-slate-300">
            <UIcon
              :name="item.icon ?? 'i-lucide-square-check'"
              class="h-3.5 w-3.5 shrink-0 text-indigo-400"
            />
            <span class="truncate">{{ item.title }}</span>
            <UBadge
              v-if="item.needsImport"
              color="neutral"
              variant="soft"
              size="xs"
              class="ms-1 shrink-0"
            >
              {{ t('contextAttachments.importsOnAdd') }}
            </UBadge>
            <button
              type="button"
              class="ms-auto shrink-0 text-slate-400 hover:text-slate-200"
              @click="removePending(item)"
            >
              <UIcon name="i-lucide-x" class="h-3.5 w-3.5" />
            </button>
          </div>
          <!-- An issue reference gets no pre-flight of its own (there is no `parseRef` to ask a
               tracker), so this line IS its warning: the fetch is attempted when the form opens and
               again on submit, and a failure now blocks the create. -->
          <p
            v-if="item.unreadable"
            class="px-2 pb-1.5 text-[11px] text-amber-400"
            data-testid="context-item-unreadable"
          >
            {{ t('contextAttachments.unreadable', { error: item.unreadable }) }}
          </p>
        </div>
      </div>
      <p v-else class="text-[11px] text-slate-500">
        {{ issuesHint }}
      </p>
    </div>
  </div>
</template>
