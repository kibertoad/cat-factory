<script setup lang="ts">
// Connect (or disconnect) the workspace to a document source. The form is
// rendered generically from the source's descriptor (credential fields), so the
// same modal serves Confluence, Notion and any future source. Secret credentials
// are write-only — the backend never returns them, so on reload we show
// "Connected" with empty fields.
//
// A source that declares an OAuth half AND has a registered app on this deployment leads with
// "Connect with <source>", and the credential form moves BELOW it as the fallback. That order is
// the point of the slice: minting a personal access token by hand is an unreasonable first step
// to put in front of a designer, and whichever affordance comes first is the one people use.
// Where no app is registered the button is absent entirely rather than disabled, because the
// remedy belongs to an admin in a different surface and a dead control states nothing.
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'
import SecretInput from '~/components/common/SecretInput.vue'

const { t } = useI18n()
const ui = useUiStore()
const documents = useDocumentsStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { confirmAction } = useConfirmAction()

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
const startingOAuth = ref(false)

/** The OAuth half is offered only when the SOURCE declares one and this deployment registered an app. */
const oauth = computed(() =>
  source.value && descriptor.value?.oauth && documents.canConnectWithOAuth(source.value)
    ? descriptor.value.oauth
    : null,
)

async function connectWithOAuth() {
  if (!source.value) return
  startingOAuth.value = true
  try {
    // Navigates away on success, so nothing after this runs; the `finally` covers the refusal
    // path (an app un-registered between the probe and the click).
    await documents.beginOAuthConnect(source.value)
  } catch (e) {
    present(e, 'documents.connect.oauth.failed', { source: descriptor.value?.label ?? '' })
  } finally {
    startingOAuth.value = false
  }
}

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
    present(e, 'documents.connect.connectFailed')
  } finally {
    saving.value = false
  }
}

async function disconnect() {
  if (!source.value) return
  const label = descriptor.value?.label ?? t('documents.connect.sourceFallback')
  if (!(await confirmAction('disconnect', label))) return
  await documents.disconnect(source.value)
  toast.add({
    title: t('documents.connect.disconnected', { source: label }),
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

        <div v-if="oauth" class="space-y-2">
          <UButton
            color="primary"
            icon="i-lucide-shield-check"
            :loading="startingOAuth"
            data-testid="document-connect-oauth"
            @click="connectWithOAuth"
          >
            {{ t('documents.connect.oauth.action', { source: descriptor.label }) }}
          </UButton>
          <p class="text-[11px] text-slate-500">
            {{ t('documents.connect.oauth.scopes', { scopes: oauth.scopes.join(', ') }) }}
          </p>
          <p class="text-[11px] text-slate-500">{{ t('documents.connect.oauth.fallback') }}</p>
        </div>

        <div class="space-y-3">
          <UFormField
            v-for="field in descriptor.credentialFields"
            :key="field.key"
            :label="field.label"
            :help="field.help"
          >
            <SecretInput
              v-model="values[field.key]"
              :secret="!!field.secret"
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
