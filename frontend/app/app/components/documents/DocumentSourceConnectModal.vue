<script setup lang="ts">
// Connect (or disconnect) the workspace to a document source. The form is
// rendered generically from the source's descriptor (credential fields), so the
// same modal serves Confluence, Notion and any future source. Secret credentials
// are write-only — the backend never returns them, so on reload we show
// "Connected" with empty fields.
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const { t } = useI18n()
const ui = useUiStore()
const documents = useDocumentsStore()
const toast = useToast()

const source = computed(() => ui.documentConnect?.source ?? null)
const descriptor = computed(() =>
  source.value ? documents.descriptorFor(source.value) : undefined,
)
const connection = computed(() =>
  source.value ? documents.connectionFor(source.value) : undefined,
)
const connected = computed(() => connection.value !== undefined)

const open = computed({
  get: () => ui.documentConnect !== null,
  set: (v: boolean) => {
    if (!v) ui.closeDocumentConnect()
  },
})
const back = useIntegrationBack(open)

/** One value per credential field, reset whenever the modal (re)opens. */
const values = ref<Record<string, string>>({})
const saving = ref(false)

watch(open, (isOpen) => {
  if (isOpen) values.value = {}
})

const canSubmit = computed(() => {
  const fields = descriptor.value?.credentialFields ?? []
  return fields.length > 0 && fields.every((f) => (values.value[f.key] ?? '').trim())
})

async function submit() {
  if (!canSubmit.value || !source.value) return
  const credentials: Record<string, string> = {}
  for (const f of descriptor.value!.credentialFields) {
    credentials[f.key] = values.value[f.key]!.trim()
  }
  saving.value = true
  try {
    await documents.connect(source.value, credentials)
    toast.add({
      title: t('documents.connect.connected', { source: descriptor.value!.label }),
      icon: 'i-lucide-check',
      color: 'success',
    })
    ui.closeDocumentConnect()
  } catch (e) {
    toast.add({
      title: t('documents.connect.connectFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}

async function disconnect() {
  if (!source.value) return
  await documents.disconnect(source.value)
  toast.add({
    title: t('documents.connect.disconnected', {
      source: descriptor.value?.label ?? t('documents.connect.sourceFallback'),
    }),
    icon: 'i-lucide-unplug',
  })
  ui.closeDocumentConnect()
}
</script>

<template>
  <UModal v-model:open="open" :title="descriptor?.label ?? t('documents.connect.title')">
    <template #title>
      <IntegrationBackTitle
        :title="descriptor?.label ?? t('documents.connect.title')"
        @back="back"
      />
    </template>
    <template #body>
      <div v-if="descriptor" class="space-y-4">
        <p class="text-sm text-slate-400">
          {{ t('documents.connect.intro', { source: descriptor.label }) }}
        </p>

        <div class="space-y-3">
          <UFormField
            v-for="field in descriptor.credentialFields"
            :key="field.key"
            :label="field.label"
            :help="field.help"
          >
            <UInput
              v-model="values[field.key]"
              :type="field.secret ? 'password' : 'text'"
              :placeholder="field.placeholder"
              class="w-full"
            />
          </UFormField>
        </div>

        <div class="flex items-center justify-between gap-2 pt-1">
          <UButton
            v-if="connected"
            color="error"
            variant="ghost"
            icon="i-lucide-unplug"
            @click="disconnect"
          >
            {{ t('documents.connect.disconnect') }}
          </UButton>
          <div v-else />
          <UButton
            color="primary"
            icon="i-lucide-plug"
            :loading="saving"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ connected ? t('documents.connect.update') : t('documents.connect.connect') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
