<script setup lang="ts">
import { DOC_KINDS } from '~/types/domain'
import type { DocKind, DocumentLinkRole, SourceDocument } from '~/types/domain'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

// Manage the workspace's per-DocKind TEMPLATE (singular) + EXEMPLAR (multi) document links (WS1).
// A kind can be pointed at one of the workspace's already-imported documents so its parsed
// sections override the built-in skeleton (template) and the author agents study it (exemplar).
// Reuses the same imported-document corpus as context linking — no new fetch surface.
const { t } = useI18n()
const ui = useUiStore()
const documents = useDocumentsStore()
const toast = useToast()

const open = computed({
  get: () => ui.documentTemplates,
  set: (v: boolean) => {
    if (!v) ui.closeDocumentTemplates()
  },
})
const back = useIntegrationBack(open)

const kind = ref<DocKind>('prd')
const busy = ref(false)
/** The imported document (`source:externalId`) selected in the "add" picker. */
const pick = ref<string | undefined>(undefined)

watch(
  open,
  (isOpen) => {
    if (isOpen) {
      pick.value = undefined
      // Surface a load failure instead of silently rendering an empty panel (which would invite
      // re-linking over links that still exist server-side).
      Promise.all([documents.loadDocuments(), documents.loadRoleLinks()]).catch((e) => {
        toast.add({
          title: t('documents.templates.loadFailed'),
          description: e instanceof Error ? e.message : String(e),
          icon: 'i-lucide-triangle-alert',
          color: 'error',
        })
      })
    }
  },
  { immediate: true },
)

const template = computed(() => documents.templateFor(kind.value))
const exemplars = computed(() => documents.exemplarsFor(kind.value))

/**
 * Imported documents the picker offers. A document row carries at most ONE (role, docKind) tag, so
 * a doc already linked as any template/exemplar is excluded — re-linking it here would silently
 * overwrite (and drop) its existing tag. Remove the existing link first to re-point it.
 */
const docItems = computed(() => {
  const tagged = new Set(documents.roleLinks.map((d) => `${d.source}:${d.externalId}`))
  return documents.documents
    .filter((d) => !tagged.has(`${d.source}:${d.externalId}`))
    .map((d) => ({ label: d.title, value: `${d.source}:${d.externalId}` }))
})

function findDoc(key: string): SourceDocument | undefined {
  return documents.documents.find((d) => `${d.source}:${d.externalId}` === key)
}

async function link(role: DocumentLinkRole) {
  const doc = pick.value ? findDoc(pick.value) : undefined
  if (!doc) return
  busy.value = true
  try {
    await documents.linkForKind(doc.source, doc.externalId, role, kind.value)
    pick.value = undefined
  } catch (e) {
    toast.add({
      title: t('documents.templates.linkFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}

async function unlink(doc: SourceDocument) {
  busy.value = true
  try {
    await documents.unlinkForKind(doc.source, doc.externalId)
  } catch (e) {
    toast.add({
      title: t('documents.templates.linkFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('documents.templates.title')">
    <template #title>
      <IntegrationBackTitle :title="t('documents.templates.title')" @back="back" />
    </template>
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-slate-400">{{ t('documents.templates.intro') }}</p>

        <!-- No imported documents yet: a template/exemplar must be an imported document. -->
        <div v-if="!documents.documents.length" class="space-y-3 text-center">
          <UIcon name="i-lucide-file-plus" class="mx-auto h-8 w-8 text-slate-500" />
          <p class="text-sm text-slate-400">{{ t('documents.templates.importFirst') }}</p>
          <UButton
            color="primary"
            variant="soft"
            icon="i-lucide-file-down"
            @click="ui.openDocumentImport(null)"
          >
            {{ t('documents.templates.importButton') }}
          </UButton>
        </div>

        <template v-else>
          <UFormField :label="t('documents.templates.kindLabel')">
            <div class="flex flex-wrap gap-1">
              <UButton
                v-for="k in DOC_KINDS"
                :key="k"
                :color="kind === k ? 'primary' : 'neutral'"
                :variant="kind === k ? 'soft' : 'ghost'"
                size="xs"
                class="uppercase"
                @click="
                  () => {
                    kind = k
                  }
                "
              >
                {{ k }}
              </UButton>
            </div>
          </UFormField>

          <!-- Template (singular per kind) ------------------------------------ -->
          <section class="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('documents.templates.templateHeading') }}
            </h3>
            <p class="mt-0.5 text-xs text-slate-500">
              {{ t('documents.templates.templateHint', { kind }) }}
            </p>
            <div
              v-if="template"
              class="mt-2 flex items-center justify-between gap-2 rounded-md bg-slate-900/70 px-3 py-2"
            >
              <a
                :href="template.url"
                target="_blank"
                rel="noopener"
                class="truncate text-sm font-medium text-white hover:underline"
              >
                {{ template.title }}
              </a>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                :loading="busy"
                @click="unlink(template)"
              >
                {{ t('documents.templates.remove') }}
              </UButton>
            </div>
            <p v-else class="mt-2 text-xs text-slate-500">
              {{ t('documents.templates.templateEmpty') }}
            </p>
          </section>

          <!-- Exemplars (multi per kind) -------------------------------------- -->
          <section class="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {{ t('documents.templates.exemplarsHeading') }}
            </h3>
            <p class="mt-0.5 text-xs text-slate-500">
              {{ t('documents.templates.exemplarsHint') }}
            </p>
            <div v-if="exemplars.length" class="mt-2 space-y-1.5">
              <div
                v-for="doc in exemplars"
                :key="`${doc.source}:${doc.externalId}`"
                class="flex items-center justify-between gap-2 rounded-md bg-slate-900/70 px-3 py-2"
              >
                <a
                  :href="doc.url"
                  target="_blank"
                  rel="noopener"
                  class="truncate text-sm font-medium text-white hover:underline"
                >
                  {{ doc.title }}
                </a>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-x"
                  :loading="busy"
                  @click="unlink(doc)"
                >
                  {{ t('documents.templates.remove') }}
                </UButton>
              </div>
            </div>
            <p v-else class="mt-2 text-xs text-slate-500">
              {{ t('documents.templates.exemplarsEmpty') }}
            </p>
          </section>

          <!-- Picker: choose an imported document, then set as template or add as example. -->
          <div class="flex items-end gap-2">
            <UFormField :label="t('documents.templates.pickLabel')" class="flex-1">
              <USelect
                v-model="pick"
                :items="docItems"
                :placeholder="t('documents.templates.pickPlaceholder')"
                class="w-full"
              />
            </UFormField>
            <UButton
              color="primary"
              variant="soft"
              icon="i-lucide-file-badge"
              :loading="busy"
              :disabled="!pick"
              @click="link('template')"
            >
              {{ t('documents.templates.setTemplate') }}
            </UButton>
            <UButton
              color="neutral"
              variant="soft"
              icon="i-lucide-star"
              :loading="busy"
              :disabled="!pick"
              @click="link('exemplar')"
            >
              {{ t('documents.templates.addExemplar') }}
            </UButton>
          </div>
        </template>
      </div>
    </template>
  </UModal>
</template>
