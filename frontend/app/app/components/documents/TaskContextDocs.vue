<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Block, DocumentSourceKind } from '~/types/domain'

// Documents (from any source) attached to a task as agent context, shown inside
// the InspectorPanel. Linked docs are fed to agents during execution (see the
// backend's userPromptFor). Rendered only when the integration is available.
const props = defineProps<{ block: Block }>()

const { t } = useI18n()
const documents = useDocumentsStore()
const ui = useUiStore()
const toast = useToast()

onMounted(() => {
  documents.loadDocuments().catch(() => {})
})

const linked = computed(() => documents.docsForBlock(props.block.id))

async function attach(source: DocumentSourceKind, externalId: string) {
  try {
    await documents.linkToBlock(props.block.id, source, externalId)
    toast.add({ title: t('documents.taskDocs.attached'), icon: 'i-lucide-link' })
  } catch (e) {
    toast.add({
      title: t('documents.taskDocs.attachFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

const attachMenu = computed<DropdownMenuItem[][]>(() => {
  const linkedKeys = new Set(linked.value.map((d) => `${d.source}:${d.externalId}`))
  const items: DropdownMenuItem[] = documents.documents
    .filter((d) => !linkedKeys.has(`${d.source}:${d.externalId}`))
    .map((d) => ({
      label: d.title,
      icon: documents.descriptorFor(d.source)?.icon ?? 'i-lucide-file-text',
      onSelect: () => attach(d.source, d.externalId),
    }))
  items.push({
    label: t('documents.taskDocs.importPage'),
    icon: 'i-lucide-file-down',
    onSelect: () => ui.openDocumentImport(null),
  })
  return [items]
})
</script>

<template>
  <div v-if="documents.available" class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('documents.taskDocs.heading') }}
      </span>
      <UDropdownMenu :items="attachMenu" :content="{ side: 'bottom', align: 'end' }">
        <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plus">{{
          t('documents.taskDocs.attach')
        }}</UButton>
      </UDropdownMenu>
    </div>

    <div v-if="linked.length" class="space-y-1">
      <a
        v-for="doc in linked"
        :key="`${doc.source}:${doc.externalId}`"
        :href="doc.url"
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
  </div>
</template>
