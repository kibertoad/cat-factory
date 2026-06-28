<script setup lang="ts">
// Connect (or disconnect) the workspace to a document source. The form is
// rendered generically from the source's descriptor (credential fields), so the
// same modal serves Confluence, Notion and any future source. Secret credentials
// are write-only — the backend never returns them, so on reload we show
// "Connected" with empty fields.
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

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
// A `credentialScope: 'user'` source (e.g. Claude Design) stores a PERSONAL credential
// keyed to the signed-in user and never shared with the workspace — surface that so a
// member understands they're connecting their own account, not the team's.
const isPersonal = computed(() => descriptor.value?.credentialScope === 'user')

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
      title: `${descriptor.value!.label} connected`,
      icon: 'i-lucide-check',
      color: 'success',
    })
    ui.closeDocumentConnect()
  } catch (e) {
    toast.add({
      title: 'Could not connect',
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
    title: `${descriptor.value?.label ?? 'Source'} disconnected`,
    icon: 'i-lucide-unplug',
  })
  ui.closeDocumentConnect()
}
</script>

<template>
  <UModal v-model:open="open" :title="descriptor?.label ?? 'Connect source'">
    <template #title>
      <IntegrationBackTitle :title="descriptor?.label ?? 'Connect source'" @back="back" />
    </template>
    <template #body>
      <div v-if="descriptor" class="space-y-4">
        <p class="text-sm text-slate-400">
          Connect {{ descriptor.label }} to import requirements, RFCs and PRDs, then spawn board
          structure or attach them to tasks as agent context.
        </p>

        <p
          v-if="isPersonal"
          class="flex items-start gap-1.5 text-xs text-amber-400/90"
          data-testid="document-source-personal-note"
        >
          <UIcon name="i-lucide-user" class="mt-0.5 size-3.5 shrink-0" />
          <span>
            Personal connection — this credential authenticates as you and is stored only for your
            account, never shared with the rest of the workspace.
          </span>
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
            Disconnect
          </UButton>
          <div v-else />
          <UButton
            color="primary"
            icon="i-lucide-plug"
            :loading="saving"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ connected ? 'Update connection' : 'Connect' }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
