<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Block } from '~/types/domain'
import { connectableSources } from '~/utils/sourcePicker'
import ContextDocumentPicker from '~/components/documents/ContextDocumentPicker.vue'
import DocumentOriginLink from '~/components/documents/DocumentOriginLink.vue'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

// Documents (from any source) attached to a task OR an initiative as agent
// context, shown inside the InspectorPanel. An initiative takes the same
// attachments (the create-initiative modal stages them exactly as the add-task one
// does) and its whole planning pipeline reads them, so it gets the same section —
// only the prose differs, which is why the hint/empty copy is level-keyed below.
// Attaching uses the SAME inline picker as task creation
// (source selector + repo→file browse + free-text search + paste-by-reference —
// ContextDocumentPicker), NOT the old dropdown that opened a second, page-level
// "Import a page…" modal on top of the inspector. Stacked page-level modals don't
// interact here, so that menu appeared to open something with nothing clickable.
// Because the block already exists, a picked item is imported-when-needed then
// linked immediately via useContextLinking (the add-task flow's shared
// orchestration), so failures surface with their real cause. Mirrors
// TaskContextIssues.vue; rendered only when the integration is available.
const props = defineProps<{ block: Block }>()

const { t } = useI18n()
const documents = useDocumentsStore()
const ui = useUiStore()
const toast = useToast()
const { linkPending, presentLinkFailures } = useContextLinking()

onMounted(() => {
  documents.loadDocuments().catch(() => {})
})

const linked = computed(() => documents.docsForBlock(props.block.id))

// Two STATIC literal keys per string, picked by level — the copy names what reads the
// document (the agents implementing a task vs the pipeline that plans an initiative), which
// is the whole point of the hint. Assembling one key from `block.level` would defeat the
// typed message-key check for a two-member choice that gains nothing from being dynamic.
const isInitiative = computed(() => props.block.level === 'initiative')
const hint = computed(() =>
  isInitiative.value ? t('documents.taskDocs.hintInitiative') : t('documents.taskDocs.hint'),
)
const emptyHint = computed(() =>
  isInitiative.value ? t('documents.taskDocs.emptyInitiative') : t('documents.taskDocs.empty'),
)
// Already-linked docs, so the inline picker filters them out / never re-offers them.
const chosenKeys = computed(() =>
  linked.value.map((d) =>
    contextKey({ kind: 'document', source: d.source, externalId: d.externalId }),
  ),
)

const connected = computed(() => documents.available && documents.anyConnected)
// Sources the user could connect right now to unlock the picker, when none is connected yet (GitHub
// docs are implicitly connected via the App, so never here). Through the shared
// `connectableSources`, which owns both terms: an integration the deployment has not configured has
// nothing to connect to, and connecting stores a workspace credential, which stays admin-tier while
// ATTACHING moved to the member tier. Offering the action to a member was a dead end (the connect
// modal opened, took a token, and 403'd); attaching is unaffected, which is the point of the split.
const { canManageIntegrations } = useWorkspaceAccess()
const connectable = computed(() =>
  connectableSources(documents.sources, {
    isConnected: documents.isConnected,
    canConnect: canManageIntegrations.value,
    available: documents.available,
  }),
)
const connectMenu = computed<DropdownMenuItem[][]>(() => [
  connectable.value.map((s) => ({
    label: s.label,
    icon: s.icon,
    onSelect: () => ui.openDocumentConnect(s.source),
  })),
])

const showPicker = ref(false)
const linking = ref(false)

// The block exists, so import-when-needed then link immediately (vs the add-task
// flow which stages the pick and links after create). linkPending never throws —
// it captures each failure with its cause for the shared presenter.
async function attach(item: PendingContext) {
  if (linking.value) return
  linking.value = true
  try {
    const failures = await linkPending(props.block.id, [item])
    if (failures.length) presentLinkFailures(failures, props.block.id)
    else toast.add({ title: t('documents.taskDocs.attached'), icon: 'i-lucide-link' })
  } finally {
    linking.value = false
  }
}
</script>

<template>
  <InspectorSection
    v-if="documents.available"
    :title="t('documents.taskDocs.heading')"
    :hint="hint"
    :count="linked.length"
  >
    <template #actions>
      <UButton
        v-if="connected"
        color="neutral"
        variant="soft"
        size="xs"
        :icon="showPicker ? 'i-lucide-x' : 'i-lucide-plus'"
        @click="showPicker = !showPicker"
      >
        {{ showPicker ? t('common.done') : t('documents.taskDocs.attach') }}
      </UButton>
      <UDropdownMenu
        v-else-if="connectable.length > 1"
        :items="connectMenu"
        :content="{ side: 'bottom', align: 'end' }"
      >
        <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plug">
          {{ t('documents.taskDocs.connectSource') }}
        </UButton>
      </UDropdownMenu>
      <UButton
        v-else-if="connectable.length === 1"
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-plug"
        @click="ui.openDocumentConnect(connectable[0]!.source)"
      >
        {{ t('documents.taskDocs.connectSourceNamed', { source: connectable[0]!.label }) }}
      </UButton>
    </template>

    <ContextDocumentPicker
      v-if="showPicker && connected"
      :chosen-keys="chosenKeys"
      @pick="attach"
    />

    <div v-if="linked.length" class="space-y-1">
      <DocumentOriginLink
        v-for="doc in linked"
        :key="`${doc.source}:${doc.externalId}`"
        :url="doc.url"
        class="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300"
        hover-class="hover:bg-slate-800/60"
      >
        <UIcon
          :name="documents.descriptorForOrigin(doc.source)?.icon ?? 'i-lucide-file-text'"
          class="h-3.5 w-3.5 shrink-0 text-indigo-400"
        />
        <span class="truncate">{{ doc.title }}</span>
      </DocumentOriginLink>
    </div>
    <p v-else class="text-[11px] text-slate-500">
      {{ emptyHint }}
    </p>
  </InspectorSection>
</template>
