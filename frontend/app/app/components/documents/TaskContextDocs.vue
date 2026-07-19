<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Block } from '~/types/domain'
import ContextDocumentPicker from '~/components/documents/ContextDocumentPicker.vue'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'

// Documents (from any source) attached to a task as agent context, shown inside
// the InspectorPanel. Attaching uses the SAME inline picker as task creation
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
// Already-linked docs, so the inline picker filters them out / never re-offers them.
const chosenKeys = computed(() =>
  linked.value.map((d) =>
    contextKey({ kind: 'document', source: d.source, externalId: d.externalId }),
  ),
)

const connected = computed(() => documents.available && documents.anyConnected)
// Sources the user could connect right now to unlock the picker, when none is
// connected yet (GitHub docs are implicitly connected via the App, so never here).
const connectableSources = computed(() =>
  documents.available ? documents.sources.filter((s) => !documents.isConnected(s.source)) : [],
)
const connectMenu = computed<DropdownMenuItem[][]>(() => [
  connectableSources.value.map((s) => ({
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
    :hint="t('documents.taskDocs.hint')"
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
        v-else-if="connectableSources.length > 1"
        :items="connectMenu"
        :content="{ side: 'bottom', align: 'end' }"
      >
        <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plug">
          {{ t('documents.taskDocs.connectSource') }}
        </UButton>
      </UDropdownMenu>
      <UButton
        v-else-if="connectableSources.length === 1"
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-plug"
        @click="ui.openDocumentConnect(connectableSources[0]!.source)"
      >
        {{ t('documents.taskDocs.connectSourceNamed', { source: connectableSources[0]!.label }) }}
      </UButton>
    </template>

    <ContextDocumentPicker
      v-if="showPicker && connected"
      :chosen-keys="chosenKeys"
      @pick="attach"
    />

    <div v-if="linked.length" class="space-y-1">
      <a
        v-for="doc in linked"
        :key="`${doc.source}:${doc.externalId}`"
        :href="doc.url"
        :title="doc.url"
        target="_blank"
        rel="noopener"
        class="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60"
      >
        <UIcon
          :name="documents.descriptorFor(doc.source)?.icon ?? 'i-lucide-file-text'"
          class="h-3.5 w-3.5 shrink-0 text-indigo-400"
        />
        <span class="truncate">{{ doc.title }}</span>
      </a>
    </div>
    <p v-else class="text-[11px] text-slate-500">
      {{ t('documents.taskDocs.empty') }}
    </p>
  </InspectorSection>
</template>
