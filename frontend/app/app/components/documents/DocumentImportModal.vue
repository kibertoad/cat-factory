<script setup lang="ts">
import type { DocumentSourceKind } from '~/types/domain'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

// Import pages from a connected document source and pick one to expand into
// board structure. A source selector lets the user choose which connected source
// to import from (Confluence, Notion, …). Carries an optional target frame from
// the inspector so "Preview & spawn" lands the structure inside that frame.
const ui = useUiStore()
const documents = useDocumentsStore()
const board = useBoardStore()
const toast = useToast()

const open = computed({
  get: () => ui.documentImport !== null,
  set: (v: boolean) => {
    if (!v) ui.closeDocumentImport()
  },
})
const back = useIntegrationBack(open)

const targetFrameId = computed(() => ui.documentImport?.targetFrameId ?? null)
const targetFrameTitle = computed(() =>
  targetFrameId.value ? board.getBlock(targetFrameId.value)?.title : null,
)

/** Which connected source we're importing from (defaults to the first). */
const source = ref<DocumentSourceKind | undefined>(undefined)
const ref_ = ref('')
const importing = ref(false)

const sourceItems = computed(() =>
  documents.connectedSources.map((s) => ({ label: s.label, value: s.source })),
)
const descriptor = computed(() =>
  source.value ? documents.descriptorFor(source.value) : undefined,
)

/** Documents imported from the currently selected source. */
const sourceDocs = computed(() =>
  source.value ? documents.documents.filter((d) => d.source === source.value) : [],
)

watch(
  open,
  (isOpen) => {
    if (isOpen) {
      ref_.value = ''
      source.value = ui.documentImport?.source ?? documents.connectedSources[0]?.source ?? undefined
      documents.loadDocuments().catch(() => {})
    }
  },
  { immediate: true },
)

async function doImport() {
  const value = ref_.value.trim()
  if (!value || !source.value) return
  importing.value = true
  try {
    const doc = await documents.importDocument(source.value, value)
    ref_.value = ''
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

function preview(externalId: string) {
  if (source.value) ui.openSpawnPreview(source.value, externalId, targetFrameId.value)
}
</script>

<template>
  <UModal v-model:open="open" title="Import from a document source">
    <template #title>
      <IntegrationBackTitle title="Import from a document source" @back="back" />
    </template>
    <template #body>
      <div v-if="!documents.anyConnected" class="space-y-3 text-center">
        <UIcon name="i-lucide-plug" class="mx-auto h-8 w-8 text-slate-500" />
        <p class="text-sm text-slate-400">Connect a document source first.</p>
        <div class="flex justify-center gap-2">
          <UButton
            v-for="s in documents.sources"
            :key="s.source"
            color="primary"
            variant="soft"
            :icon="s.icon"
            @click="ui.openDocumentConnect(s.source)"
          >
            Connect {{ s.label }}
          </UButton>
        </div>
      </div>

      <div v-else class="space-y-4">
        <p v-if="targetFrameTitle" class="text-xs text-slate-400">
          Spawning into <span class="font-medium text-slate-200">{{ targetFrameTitle }}</span>
        </p>

        <UFormField v-if="sourceItems.length > 1" label="Source">
          <USelect v-model="source" :items="sourceItems" class="w-full" />
        </UFormField>

        <div class="flex items-end gap-2">
          <UFormField :label="descriptor?.refLabel ?? 'Page URL or ID'" class="flex-1">
            <UInput
              v-model="ref_"
              :placeholder="descriptor?.refPlaceholder"
              class="w-full"
              @keydown.enter="doImport"
            />
          </UFormField>
          <UButton
            color="primary"
            icon="i-lucide-file-down"
            :loading="importing"
            :disabled="!ref_.trim()"
            @click="doImport"
          >
            Import
          </UButton>
        </div>

        <div v-if="sourceDocs.length" class="space-y-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Imported documents
          </h3>
          <div
            v-for="doc in sourceDocs"
            :key="`${doc.source}:${doc.externalId}`"
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
                @click="preview(doc.externalId)"
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
