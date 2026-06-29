<script setup lang="ts">
// The Kubernetes "ephemeral environment backend" connect form — one option of the
// environment tab's backend-type selector (the other being the BYO HTTP manifest editor).
// It builds the discriminated `{ kind: 'kubernetes', kubernetes }` config plus the
// `apiToken` secret bundle and emits test/save to the parent tab (which calls the shared
// provider-connections store). The K8s env config differs from the runner K8s config
// (manifest source + URL derivation vs an executor image + namespace), so it has its own
// form rather than reusing KubernetesRunnerForm.
import { computed, reactive, ref, watch } from 'vue'
import { KUBERNETES_ENV_TOKEN_SECRET_KEY } from '@cat-factory/contracts'
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
  caCertPem: '',
  insecureSkipTlsVerify: false,
  namespaceTemplate: '',
  imageTemplate: '',
  // manifest source
  manifestSourceType: 'colocated' as 'colocated' | 'separate',
  manifestPath: '',
  manifestRepo: '',
  manifestRef: '',
  // url derivation
  urlSource: 'ingressTemplate' as 'ingressTemplate' | 'ingressStatus' | 'serviceStatus',
  hostTemplate: '',
  ingressName: '',
  serviceName: '',
  servicePort: '',
  urlScheme: '' as '' | 'http' | 'https',
})
const apiToken = ref('')

const manifestSourceItems = computed(() => [
  { label: t('settings.providerConnection.kubernetesEnv.sourceColocated'), value: 'colocated' },
  { label: t('settings.providerConnection.kubernetesEnv.sourceSeparate'), value: 'separate' },
])
const urlSourceItems = computed(() => [
  {
    label: t('settings.providerConnection.kubernetesEnv.urlIngressTemplate'),
    value: 'ingressTemplate',
  },
  {
    label: t('settings.providerConnection.kubernetesEnv.urlIngressStatus'),
    value: 'ingressStatus',
  },
  {
    label: t('settings.providerConnection.kubernetesEnv.urlServiceStatus'),
    value: 'serviceStatus',
  },
])
const schemeItems = computed(() => [
  { label: t('settings.providerConnection.kubernetesEnv.schemeDefault'), value: '' },
  { label: 'https', value: 'https' },
  { label: 'http', value: 'http' },
])

// A registered k8s env connection exposes its non-secret config, so prefill every
// non-secret field from it (never the token — secrets are write-only and re-entered on
// update). This lets an edit change one field without re-typing the whole form.
watch(
  () => props.connection,
  (c) => {
    if (c?.kind !== 'kubernetes') return
    const k =
      c.config && (c.config as { kind?: string }).kind === 'kubernetes'
        ? (c.config as { kubernetes: Record<string, unknown> }).kubernetes
        : undefined
    if (!k) return
    form.label = typeof k.label === 'string' ? k.label : ''
    form.apiServerUrl = typeof k.apiServerUrl === 'string' ? k.apiServerUrl : ''
    form.caCertPem = typeof k.caCertPem === 'string' ? k.caCertPem : ''
    form.insecureSkipTlsVerify = k.insecureSkipTlsVerify === true
    form.namespaceTemplate = typeof k.namespaceTemplate === 'string' ? k.namespaceTemplate : ''
    form.imageTemplate = typeof k.imageTemplate === 'string' ? k.imageTemplate : ''
    const src = k.manifestSource as Record<string, unknown> | undefined
    if (src?.type === 'separate') {
      form.manifestSourceType = 'separate'
      form.manifestRepo = typeof src.repo === 'string' ? src.repo : ''
      form.manifestRef = typeof src.ref === 'string' ? src.ref : ''
      form.manifestPath = typeof src.path === 'string' ? src.path : ''
    } else if (src?.type === 'colocated') {
      form.manifestSourceType = 'colocated'
      form.manifestPath = typeof src.path === 'string' ? src.path : ''
    }
    const url = k.url as Record<string, unknown> | undefined
    if (url?.source === 'ingressTemplate') {
      form.urlSource = 'ingressTemplate'
      form.hostTemplate = typeof url.hostTemplate === 'string' ? url.hostTemplate : ''
    } else if (url?.source === 'ingressStatus') {
      form.urlSource = 'ingressStatus'
      form.ingressName = typeof url.ingressName === 'string' ? url.ingressName : ''
    } else if (url?.source === 'serviceStatus') {
      form.urlSource = 'serviceStatus'
      form.serviceName = typeof url.serviceName === 'string' ? url.serviceName : ''
      form.servicePort = typeof url.port === 'number' ? String(url.port) : ''
    }
    if (url && (url.scheme === 'http' || url.scheme === 'https')) form.urlScheme = url.scheme
  },
  { immediate: true },
)

// Mirror kubernetesManifestSourceSchema's `owner/repo` regex so a slashless value is
// caught here with a field hint instead of a generic 422 from the backend.
const repoShapeValid = computed(() => /^[^/\s]+\/[^/\s]+$/.test(form.manifestRepo.trim()))
const manifestSourceValid = computed(() =>
  form.manifestSourceType === 'separate'
    ? repoShapeValid.value && !!form.manifestPath.trim()
    : !!form.manifestPath.trim(),
)
// serviceStatus.port is an optional integer 1..65535 (kubernetesUrlSourceSchema). Validate
// it here so a decimal isn't silently dropped and an out-of-range value isn't sent then 422'd.
const servicePortValid = computed(() => {
  const raw = form.servicePort.trim()
  if (!raw) return true
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1 && port <= 65535
})
const urlValid = computed(() => {
  if (form.urlSource === 'ingressTemplate') return !!form.hostTemplate.trim()
  if (form.urlSource === 'serviceStatus') return !!form.serviceName.trim() && servicePortValid.value
  return true // ingressStatus has no required field
})

const canSave = computed(
  () =>
    !!form.label.trim() &&
    !!form.apiServerUrl.trim() &&
    !!apiToken.value.trim() &&
    manifestSourceValid.value &&
    urlValid.value,
)

function buildManifestSource(): Record<string, unknown> {
  if (form.manifestSourceType === 'separate') {
    const src: Record<string, unknown> = {
      type: 'separate',
      repo: form.manifestRepo.trim(),
      path: form.manifestPath.trim(),
    }
    if (form.manifestRef.trim()) src.ref = form.manifestRef.trim()
    return src
  }
  return { type: 'colocated', path: form.manifestPath.trim() }
}

function buildUrl(): Record<string, unknown> {
  const url: Record<string, unknown> = { source: form.urlSource }
  if (form.urlSource === 'ingressTemplate') {
    url.hostTemplate = form.hostTemplate.trim()
  } else if (form.urlSource === 'ingressStatus') {
    if (form.ingressName.trim()) url.ingressName = form.ingressName.trim()
  } else {
    url.serviceName = form.serviceName.trim()
    const port = Number(form.servicePort)
    if (form.servicePort.trim() && Number.isInteger(port)) url.port = port
  }
  if (form.urlScheme) url.scheme = form.urlScheme
  return url
}

function buildPayload(): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const kubernetes: Record<string, unknown> = {
    label: form.label.trim(),
    apiServerUrl: form.apiServerUrl.trim(),
    manifestSource: buildManifestSource(),
    url: buildUrl(),
  }
  if (form.caCertPem.trim()) kubernetes.caCertPem = form.caCertPem.trim()
  if (form.insecureSkipTlsVerify) kubernetes.insecureSkipTlsVerify = true
  if (form.namespaceTemplate.trim()) kubernetes.namespaceTemplate = form.namespaceTemplate.trim()
  if (form.imageTemplate.trim()) kubernetes.imageTemplate = form.imageTemplate.trim()
  return {
    config: { kind: 'kubernetes', kubernetes },
    secrets: { [KUBERNETES_ENV_TOKEN_SECRET_KEY]: apiToken.value.trim() },
  }
}

function optional(label: string): string {
  return t('settings.providerConnection.form.optionalLabel', { label })
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

    <UFormField :label="t('settings.providerConnection.kubernetesEnv.label')">
      <UInput
        v-model="form.label"
        :placeholder="t('settings.providerConnection.kubernetesEnv.labelPlaceholder')"
      />
    </UFormField>

    <UFormField
      :label="t('settings.providerConnection.kubernetesEnv.apiServerUrl')"
      :help="t('settings.providerConnection.kubernetesEnv.apiServerUrlHelp')"
    >
      <UInput v-model="form.apiServerUrl" class="font-mono" placeholder="https://10.0.0.1:6443" />
    </UFormField>

    <UFormField
      :label="t('settings.providerConnection.kubernetesEnv.apiToken')"
      :help="t('settings.providerConnection.kubernetesEnv.apiTokenHelp')"
    >
      <UInput v-model="apiToken" type="password" class="font-mono" />
    </UFormField>

    <!-- Manifest source: where the per-PR resources are read from. -->
    <UFormField :label="t('settings.providerConnection.kubernetesEnv.manifestSourceLabel')">
      <USelect v-model="form.manifestSourceType" :items="manifestSourceItems" />
    </UFormField>

    <UFormField
      v-if="form.manifestSourceType === 'separate'"
      :label="t('settings.providerConnection.kubernetesEnv.repo')"
      :help="t('settings.providerConnection.kubernetesEnv.repoHelp')"
    >
      <UInput v-model="form.manifestRepo" class="font-mono" placeholder="acme/preview-manifests" />
    </UFormField>

    <UFormField
      v-if="form.manifestSourceType === 'separate'"
      :label="optional(t('settings.providerConnection.kubernetesEnv.ref'))"
      :help="t('settings.providerConnection.kubernetesEnv.refHelp')"
    >
      <UInput v-model="form.manifestRef" class="font-mono" placeholder="main" />
    </UFormField>

    <UFormField
      :label="t('settings.providerConnection.kubernetesEnv.path')"
      :help="t('settings.providerConnection.kubernetesEnv.pathHelp')"
    >
      <UInput v-model="form.manifestPath" class="font-mono" placeholder="k8s/preview" />
    </UFormField>

    <!-- URL derivation: how the live environment URL is resolved once applied. -->
    <UFormField :label="t('settings.providerConnection.kubernetesEnv.urlSourceLabel')">
      <USelect v-model="form.urlSource" :items="urlSourceItems" />
    </UFormField>

    <UFormField
      v-if="form.urlSource === 'ingressTemplate'"
      :label="t('settings.providerConnection.kubernetesEnv.hostTemplate')"
      :help="t('settings.providerConnection.kubernetesEnv.hostTemplateHelp')"
    >
      <UInput
        v-model="form.hostTemplate"
        class="font-mono"
        placeholder="{{branch}}.preview.example.com"
      />
    </UFormField>

    <UFormField
      v-if="form.urlSource === 'ingressStatus'"
      :label="optional(t('settings.providerConnection.kubernetesEnv.ingressName'))"
      :help="t('settings.providerConnection.kubernetesEnv.ingressNameHelp')"
    >
      <UInput v-model="form.ingressName" class="font-mono" />
    </UFormField>

    <UFormField
      v-if="form.urlSource === 'serviceStatus'"
      :label="t('settings.providerConnection.kubernetesEnv.serviceName')"
    >
      <UInput v-model="form.serviceName" class="font-mono" />
    </UFormField>

    <UFormField
      v-if="form.urlSource === 'serviceStatus'"
      :label="optional(t('settings.providerConnection.kubernetesEnv.port'))"
    >
      <UInput
        v-model="form.servicePort"
        type="number"
        :min="1"
        :max="65535"
        class="font-mono"
        placeholder="80"
      />
    </UFormField>

    <UFormField :label="optional(t('settings.providerConnection.kubernetesEnv.scheme'))">
      <USelect v-model="form.urlScheme" :items="schemeItems" />
    </UFormField>

    <!-- Optional refinements. -->
    <UFormField
      :label="optional(t('settings.providerConnection.kubernetesEnv.namespaceTemplate'))"
      :help="t('settings.providerConnection.kubernetesEnv.namespaceTemplateHelp')"
    >
      <UInput
        v-model="form.namespaceTemplate"
        class="font-mono"
        placeholder="cf-env-{{pullNumber}}"
      />
    </UFormField>

    <UFormField
      :label="optional(t('settings.providerConnection.kubernetesEnv.imageTemplate'))"
      :help="t('settings.providerConnection.kubernetesEnv.imageTemplateHelp')"
    >
      <UInput v-model="form.imageTemplate" class="font-mono" />
    </UFormField>

    <UFormField
      :label="optional(t('settings.providerConnection.kubernetesEnv.caCertPem'))"
      :help="t('settings.providerConnection.kubernetesEnv.caCertPemHelp')"
    >
      <UTextarea
        v-model="form.caCertPem"
        :rows="3"
        class="font-mono"
        placeholder="-----BEGIN CERTIFICATE-----"
      />
    </UFormField>

    <UFormField :help="t('settings.providerConnection.kubernetesEnv.insecureSkipTlsVerifyHelp')">
      <UCheckbox
        v-model="form.insecureSkipTlsVerify"
        :label="t('settings.providerConnection.kubernetesEnv.insecureSkipTlsVerify')"
      />
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
