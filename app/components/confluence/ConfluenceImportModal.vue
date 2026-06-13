<script setup lang="ts">
// Import Confluence pages and pick one to expand into board structure. Carries
// an optional target frame from the inspector so "Preview & spawn" lands the
// structure inside that frame.
const ui = useUiStore()
const confluence = useConfluenceStore()
const board = useBoardStore()
const toast = useToast()

const open = computed({
  get: () => ui.confluenceImport !== null,
  set: (v: boolean) => {
    if (!v) ui.closeConfluenceImport()
  },
})

const targetFrameId = computed(() => ui.confluenceImport?.targetFrameId ?? null)
const targetFrameTitle = computed(() =>
  targetFrameId.value ? board.getBlock(targetFrameId.value)?.title : null,
)

const page = ref('')
const importing = ref(false)

watch(open, (isOpen) => {
  if (isOpen) {
    page.value = ''
    confluence.loadDocuments().catch(() => {})
  }
})

async function doImport() {
  const value = page.value.trim()
  if (!value) return
  importing.value = true
  try {
    const doc = await confluence.importDocument(value)
    page.value = ''
    toast.add({ title: `Imported "${doc.title}"`, icon: 'i-lucide-file-down' })
  } catch (e) {
    toast.add({
      title: 'Import failed',
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    importing.value = false
  }
}

function preview(pageId: string) {
  ui.openSpawnPreview(pageId, targetFrameId.value)
}
</script>

<template>
  <UModal v-model:open="open" title="Import from Confluence">
    <template #body>
      <div v-if="!confluence.connected" class="space-y-3 text-center">
        <UIcon name="i-lucide-plug" class="mx-auto h-8 w-8 text-slate-500" />
        <p class="text-sm text-slate-400">Connect a Confluence site first.</p>
        <UButton color="primary" variant="soft" @click="ui.openConfluenceConnect()">
          Connect Confluence
        </UButton>
      </div>

      <div v-else class="space-y-4">
        <p v-if="targetFrameTitle" class="text-xs text-slate-400">
          Spawning into <span class="font-medium text-slate-200">{{ targetFrameTitle }}</span>
        </p>

        <div class="flex items-end gap-2">
          <UFormField label="Page URL or ID" class="flex-1">
            <UInput
              v-model="page"
              placeholder="https://…/pages/12345/Title  or  12345"
              class="w-full"
              @keydown.enter="doImport"
            />
          </UFormField>
          <UButton
            color="primary"
            icon="i-lucide-file-down"
            :loading="importing"
            :disabled="!page.trim()"
            @click="doImport"
          >
            Import
          </UButton>
        </div>

        <div v-if="confluence.documents.length" class="space-y-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Imported documents
          </h3>
          <div
            v-for="doc in confluence.documents"
            :key="doc.pageId"
            class="rounded-lg border border-slate-800 bg-slate-900/60 p-3"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <a
                  :href="doc.url"
                  target="_blank"
                  rel="noopener"
                  class="truncate text-sm font-medium text-white hover:underline"
                >
                  {{ doc.title }}
                </a>
                <p class="mt-0.5 line-clamp-2 text-xs text-slate-500">{{ doc.excerpt }}</p>
              </div>
              <UButton
                color="primary"
                variant="soft"
                size="xs"
                icon="i-lucide-wand-sparkles"
                @click="preview(doc.pageId)"
              >
                Preview &amp; spawn
              </UButton>
            </div>
          </div>
        </div>
        <p v-else class="text-center text-xs text-slate-500">No documents imported yet.</p>
      </div>
    </template>
  </UModal>
</template>
