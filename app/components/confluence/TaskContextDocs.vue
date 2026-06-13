<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Block } from '~/types/domain'

// Confluence documents attached to a task as agent context, shown inside the
// InspectorPanel. Linked docs are fed to agents during execution (see the
// backend's userPromptFor). Rendered only when the integration is available.
const props = defineProps<{ block: Block }>()

const confluence = useConfluenceStore()
const ui = useUiStore()
const toast = useToast()

onMounted(() => {
  confluence.loadDocuments().catch(() => {})
})

const linked = computed(() => confluence.docsForBlock(props.block.id))

async function attach(pageId: string) {
  try {
    await confluence.linkToBlock(props.block.id, pageId)
    toast.add({ title: 'Document attached', icon: 'i-lucide-link' })
  } catch (e) {
    toast.add({
      title: 'Could not attach',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}

const attachMenu = computed<DropdownMenuItem[][]>(() => {
  const linkedIds = new Set(linked.value.map((d) => d.pageId))
  const items: DropdownMenuItem[] = confluence.documents
    .filter((d) => !linkedIds.has(d.pageId))
    .map((d) => ({
      label: d.title,
      icon: 'i-lucide-file-text',
      onSelect: () => attach(d.pageId),
    }))
  items.push({
    label: 'Import a page…',
    icon: 'i-lucide-file-down',
    onSelect: () => ui.openConfluenceImport(null),
  })
  return [items]
})
</script>

<template>
  <div v-if="confluence.available" class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Context documents
      </span>
      <UDropdownMenu :items="attachMenu" :content="{ side: 'bottom', align: 'end' }">
        <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plus">Attach</UButton>
      </UDropdownMenu>
    </div>

    <div v-if="linked.length" class="space-y-1">
      <a
        v-for="doc in linked"
        :key="doc.pageId"
        :href="doc.url"
        target="_blank"
        rel="noopener"
        class="flex items-center gap-1.5 rounded-md border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800/60"
      >
        <UIcon name="i-lucide-file-text" class="h-3.5 w-3.5 shrink-0 text-indigo-400" />
        <span class="truncate">{{ doc.title }}</span>
      </a>
    </div>
    <p v-else class="text-[11px] text-slate-500">
      Attach a requirement, RFC or PRD so agents see it while implementing this task.
    </p>
  </div>
</template>
