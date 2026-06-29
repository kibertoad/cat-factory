<script setup lang="ts">
// The Kubernetes "agent runner backend" connect form — one option of the runner-pool tab's
// backend-type selector (the other being the manifest pool). It builds the discriminated
// `{ kind: 'kubernetes', kubernetes }` config + the `apiToken` secret bundle and emits
// test/save to the parent tab (which calls the shared provider-connections store).
import { computed, reactive, ref, watch } from 'vue'
import type { ProviderConnection } from '~/types/providerConnections'

const props = defineProps<{
  connection: ProviderConnection | null
  supportsTest: boolean
  testing: boolean
  busy: boolean
  testResult: { ok: boolean; message?: string } | null
}>()

const emit = defineEmits<{
  test: [payload: { config: Record<string, unknown>; secrets: Record<string, string> }]
  save: [payload: { config: Record<string, unknown>; secrets: Record<string, string> }]
}>()

const { t } = useI18n()

const form = reactive({
  label: '',
  apiServerUrl: '',
  namespace: '',
  image: '',
  imageUi: '',
  caCertPem: '',
  harnessPort: '',
})
const apiToken = ref('')

// A registered k8s connection exposes only safe metadata, so prefill the label + apiserver
// URL from it (never the token — secrets are write-only and re-entered on update).
watch(
  () => props.connection,
  (c) => {
    if (c?.kind === 'kubernetes') {
      form.label = c.label
      form.apiServerUrl = c.baseUrl
    }
  },
  { immediate: true },
)

const canSave = computed(
  () =>
    !!form.label.trim() &&
    !!form.apiServerUrl.trim() &&
    !!form.namespace.trim() &&
    !!form.image.trim() &&
    !!apiToken.value.trim(),
)

function buildPayload(): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const kubernetes: Record<string, unknown> = {
    label: form.label.trim(),
    apiServerUrl: form.apiServerUrl.trim(),
    namespace: form.namespace.trim(),
    image: form.image.trim(),
  }
  if (form.imageUi.trim()) kubernetes.imageUi = form.imageUi.trim()
  if (form.caCertPem.trim()) kubernetes.caCertPem = form.caCertPem
  const port = Number(form.harnessPort)
  if (form.harnessPort.trim() && Number.isFinite(port)) kubernetes.harnessPort = port
  return {
    config: { kind: 'kubernetes', kubernetes },
    secrets: { apiToken: apiToken.value.trim() },
  }
}
</script>

<template>
  <div class="rounded-lg border border-dashed border-slate-700 p-3 space-y-3">
    <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
      {{
        connection?.kind === 'kubernetes'
          ? t('settings.providerConnection.form.updateConfiguration')
          : t('settings.providerConnection.form.connect')
      }}
    </p>

    <UFormField :label="t('settings.providerConnection.kubernetes.label')">
      <UInput
        v-model="form.label"
        :placeholder="t('settings.providerConnection.kubernetes.labelPlaceholder')"
      />
    </UFormField>

    <UFormField
      :label="t('settings.providerConnection.kubernetes.apiServerUrl')"
      :help="t('settings.providerConnection.kubernetes.apiServerUrlHelp')"
    >
      <UInput v-model="form.apiServerUrl" class="font-mono" placeholder="https://10.0.0.1:6443" />
    </UFormField>

    <UFormField :label="t('settings.providerConnection.kubernetes.namespace')">
      <UInput v-model="form.namespace" class="font-mono" placeholder="cat-factory" />
    </UFormField>

    <UFormField
      :label="t('settings.providerConnection.kubernetes.image')"
      :help="t('settings.providerConnection.kubernetes.imageHelp')"
    >
      <UInput
        v-model="form.image"
        class="font-mono"
        placeholder="ghcr.io/acme/cat-factory-executor:latest"
      />
    </UFormField>

    <UFormField
      :label="
        t('settings.providerConnection.form.optionalLabel', {
          label: t('settings.providerConnection.kubernetes.imageUi'),
        })
      "
    >
      <UInput v-model="form.imageUi" class="font-mono" />
    </UFormField>

    <UFormField
      :label="t('settings.providerConnection.kubernetes.apiToken')"
      :help="t('settings.providerConnection.kubernetes.apiTokenHelp')"
    >
      <UInput v-model="apiToken" type="password" class="font-mono" />
    </UFormField>

    <UFormField
      :label="
        t('settings.providerConnection.form.optionalLabel', {
          label: t('settings.providerConnection.kubernetes.caCertPem'),
        })
      "
      :help="t('settings.providerConnection.kubernetes.caCertPemHelp')"
    >
      <UTextarea
        v-model="form.caCertPem"
        :rows="3"
        class="font-mono"
        placeholder="-----BEGIN CERTIFICATE-----"
      />
    </UFormField>

    <UFormField
      :label="
        t('settings.providerConnection.form.optionalLabel', {
          label: t('settings.providerConnection.kubernetes.harnessPort'),
        })
      "
    >
      <UInput v-model="form.harnessPort" type="number" class="font-mono" placeholder="8080" />
    </UFormField>

    <div v-if="supportsTest" class="flex items-center gap-2">
      <UButton
        color="neutral"
        variant="soft"
        size="sm"
        icon="i-lucide-plug-zap"
        :loading="testing"
        :disabled="!canSave"
        @click="emit('test', buildPayload())"
      >
        {{ t('settings.providerConnection.test.button') }}
      </UButton>
      <span v-if="testResult && testResult.ok" class="text-xs text-emerald-400">
        {{ testResult.message ?? t('settings.providerConnection.test.ok') }}
      </span>
      <span v-else-if="testResult" class="text-xs text-rose-400">
        {{ testResult.message ?? t('settings.providerConnection.test.failed') }}
      </span>
    </div>

    <div class="flex justify-end">
      <UButton
        color="primary"
        size="sm"
        :loading="busy"
        :disabled="!canSave"
        @click="emit('save', buildPayload())"
      >
        {{
          connection?.kind === 'kubernetes'
            ? t('common.save')
            : t('settings.providerConnection.form.connect')
        }}
      </UButton>
    </div>
  </div>
</template>
