<script setup lang="ts">
// The kube ENGINE connection form for a `kubernetes` provision-type handler — the "how"
// (apiserver + TLS + namespace + URL derivation), split from the service-owned manifest
// source (the "what/where", configured on the service in ServiceTestConfig). Serves both the
// `local-k3s` and `remote-kubernetes` engines (they share `kubernetesEngineConfigSchema`); the
// parent passes the selected engine and gets back the discriminated `{ engine, kubernetes }`
// config + the `apiToken` secret bundle. Distinct from KubernetesEnvironmentForm (the legacy
// single-connection backend, which still carries the manifest source inline).
import { computed, reactive, ref, watch } from 'vue'
import { KUBERNETES_ENV_TOKEN_SECRET_KEY } from '@cat-factory/contracts'
import type {
  EnvironmentHandlerView,
  InfraEngine,
  InfraHandlerConfig,
} from '@cat-factory/contracts'

// The kube branch of the discriminated handler config this form produces (the `local-k3s` /
// `remote-kubernetes` engines share `kubernetesEngineConfigSchema`). Emitting this typed
// (rather than a bare `Record`) lets the parent pass it straight to registerHandler with no
// `as never` cast, so a wrong config shape is caught at the call site instead of server-side.
type KubeHandlerConfig = Extract<InfraHandlerConfig, { engine: 'local-k3s' | 'remote-kubernetes' }>
type KubeHandlerPayload = { config: KubeHandlerConfig; secrets: Record<string, string> }

const props = defineProps<{
  /** `local-k3s` or `remote-kubernetes` — the engine this handler is registered under. */
  engine: Extract<InfraEngine, 'local-k3s' | 'remote-kubernetes'>
  /** The registered handler (if any) — prefills every non-secret field on edit. */
  handler: EnvironmentHandlerView | null
  supportsTest: boolean
  testing: boolean
  busy: boolean
  testResult: { ok: boolean; message?: string } | null
}>()

const emit = defineEmits<{
  test: [payload: KubeHandlerPayload]
  save: [payload: KubeHandlerPayload]
}>()

const { t } = useI18n()

type UrlSource =
  | 'ingressTemplate'
  | 'ingressStatus'
  | 'serviceStatus'
  | 'gatewayStatus'
  | 'httpRouteStatus'

const form = reactive({
  label: '',
  apiServerUrl: '',
  caCertPem: '',
  insecureSkipTlsVerify: false,
  namespaceTemplate: '',
  imageTemplate: '',
  urlSource: 'ingressTemplate' as UrlSource,
  hostTemplate: '',
  ingressName: '',
  serviceName: '',
  servicePort: '',
  gatewayName: '',
  httpRouteName: '',
  urlScheme: '' as '' | 'http' | 'https',
})
const apiToken = ref('')

const urlSourceItems = computed(() => [
  {
    label: t('settings.infrastructure.kubernetesEngine.urlIngressTemplate'),
    value: 'ingressTemplate',
  },
  { label: t('settings.infrastructure.kubernetesEngine.urlIngressStatus'), value: 'ingressStatus' },
  { label: t('settings.infrastructure.kubernetesEngine.urlServiceStatus'), value: 'serviceStatus' },
  { label: t('settings.infrastructure.kubernetesEngine.urlGatewayStatus'), value: 'gatewayStatus' },
  {
    label: t('settings.infrastructure.kubernetesEngine.urlHttpRouteStatus'),
    value: 'httpRouteStatus',
  },
])
const schemeItems = computed(() => [
  { label: t('settings.infrastructure.kubernetesEngine.schemeDefault'), value: '' },
  { label: 'https', value: 'https' },
  { label: 'http', value: 'http' },
])

// Prefill every non-secret field from a registered handler's stored config (never the token —
// secrets are write-only and re-entered on update), so an edit changes one field without
// re-typing the form.
watch(
  () => props.handler,
  (h) => {
    const cfg = h?.config
    if (!cfg || (cfg.engine !== 'local-k3s' && cfg.engine !== 'remote-kubernetes')) return
    const k = cfg.kubernetes as Record<string, unknown>
    form.label = typeof k.label === 'string' ? k.label : ''
    form.apiServerUrl = typeof k.apiServerUrl === 'string' ? k.apiServerUrl : ''
    form.caCertPem = typeof k.caCertPem === 'string' ? k.caCertPem : ''
    form.insecureSkipTlsVerify = k.insecureSkipTlsVerify === true
    form.namespaceTemplate = typeof k.namespaceTemplate === 'string' ? k.namespaceTemplate : ''
    form.imageTemplate = typeof k.imageTemplate === 'string' ? k.imageTemplate : ''
    const url = k.url as Record<string, unknown> | undefined
    const src = typeof url?.source === 'string' ? (url.source as UrlSource) : 'ingressTemplate'
    form.urlSource = src
    form.hostTemplate = typeof url?.hostTemplate === 'string' ? url.hostTemplate : ''
    form.ingressName = typeof url?.ingressName === 'string' ? url.ingressName : ''
    form.serviceName = typeof url?.serviceName === 'string' ? url.serviceName : ''
    form.servicePort = typeof url?.port === 'number' ? String(url.port) : ''
    form.gatewayName = typeof url?.gatewayName === 'string' ? url.gatewayName : ''
    form.httpRouteName = typeof url?.httpRouteName === 'string' ? url.httpRouteName : ''
    if (url?.scheme === 'http' || url?.scheme === 'https') form.urlScheme = url.scheme
  },
  { immediate: true },
)

const servicePortValid = computed(() => {
  const raw = form.servicePort.trim()
  if (!raw) return true
  const port = Number(raw)
  return Number.isInteger(port) && port >= 1 && port <= 65535
})
const urlValid = computed(() => {
  if (form.urlSource === 'ingressTemplate') return !!form.hostTemplate.trim()
  if (form.urlSource === 'serviceStatus') return !!form.serviceName.trim() && servicePortValid.value
  return true // ingressStatus / gatewayStatus / httpRouteStatus have no required field
})

const connected = computed(() => !!props.handler)
const canSave = computed(
  () =>
    !!form.label.trim() && !!form.apiServerUrl.trim() && !!apiToken.value.trim() && urlValid.value,
)

function buildUrl(): Record<string, unknown> {
  const url: Record<string, unknown> = { source: form.urlSource }
  if (form.urlSource === 'ingressTemplate') {
    url.hostTemplate = form.hostTemplate.trim()
  } else if (form.urlSource === 'ingressStatus') {
    if (form.ingressName.trim()) url.ingressName = form.ingressName.trim()
  } else if (form.urlSource === 'serviceStatus') {
    url.serviceName = form.serviceName.trim()
    const port = Number(form.servicePort)
    if (form.servicePort.trim() && Number.isInteger(port)) url.port = port
  } else if (form.urlSource === 'gatewayStatus') {
    if (form.gatewayName.trim()) url.gatewayName = form.gatewayName.trim()
  } else {
    if (form.httpRouteName.trim()) url.httpRouteName = form.httpRouteName.trim()
  }
  if (form.urlScheme) url.scheme = form.urlScheme
  return url
}

function buildPayload(): KubeHandlerPayload {
  const kubernetes: Record<string, unknown> = {
    label: form.label.trim(),
    apiServerUrl: form.apiServerUrl.trim(),
    url: buildUrl(),
  }
  if (form.caCertPem.trim()) kubernetes.caCertPem = form.caCertPem.trim()
  if (form.insecureSkipTlsVerify) kubernetes.insecureSkipTlsVerify = true
  if (form.namespaceTemplate.trim()) kubernetes.namespaceTemplate = form.namespaceTemplate.trim()
  if (form.imageTemplate.trim()) kubernetes.imageTemplate = form.imageTemplate.trim()
  // One honest assertion at the boundary that actually builds the shape (the reactive form is
  // dynamically assembled, then validated server-side); the emitted config flows typed onward.
  return {
    config: { engine: props.engine, kubernetes } as unknown as KubeHandlerConfig,
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
        connected
          ? t('settings.providerConnection.form.updateConfiguration')
          : t('settings.providerConnection.form.connect')
      }}
    </p>

    <UFormField :label="t('settings.infrastructure.kubernetesEngine.label')">
      <UInput
        v-model="form.label"
        :placeholder="t('settings.infrastructure.kubernetesEngine.labelPlaceholder')"
      />
    </UFormField>

    <UFormField
      :label="t('settings.infrastructure.kubernetesEngine.apiServerUrl')"
      :help="t('settings.infrastructure.kubernetesEngine.apiServerUrlHelp')"
    >
      <UInput v-model="form.apiServerUrl" class="font-mono" placeholder="https://10.0.0.1:6443" />
    </UFormField>

    <UFormField
      :label="t('settings.infrastructure.kubernetesEngine.apiToken')"
      :help="t('settings.infrastructure.kubernetesEngine.apiTokenHelp')"
    >
      <UInput v-model="apiToken" type="password" class="font-mono" autocomplete="off" />
    </UFormField>

    <!-- URL derivation: how the live environment URL is resolved once the service's
         manifests are applied. -->
    <UFormField :label="t('settings.infrastructure.kubernetesEngine.urlSourceLabel')">
      <USelect v-model="form.urlSource" :items="urlSourceItems" />
    </UFormField>

    <UFormField
      v-if="form.urlSource === 'ingressTemplate'"
      :label="t('settings.infrastructure.kubernetesEngine.hostTemplate')"
      :help="t('settings.infrastructure.kubernetesEngine.hostTemplateHelp')"
    >
      <UInput
        v-model="form.hostTemplate"
        class="font-mono"
        placeholder="{{branch}}.preview.example.com"
      />
    </UFormField>

    <UFormField
      v-if="form.urlSource === 'ingressStatus'"
      :label="optional(t('settings.infrastructure.kubernetesEngine.ingressName'))"
    >
      <UInput v-model="form.ingressName" class="font-mono" />
    </UFormField>

    <UFormField
      v-if="form.urlSource === 'serviceStatus'"
      :label="t('settings.infrastructure.kubernetesEngine.serviceName')"
    >
      <UInput v-model="form.serviceName" class="font-mono" />
    </UFormField>
    <UFormField
      v-if="form.urlSource === 'serviceStatus'"
      :label="optional(t('settings.infrastructure.kubernetesEngine.port'))"
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

    <UFormField
      v-if="form.urlSource === 'gatewayStatus'"
      :label="optional(t('settings.infrastructure.kubernetesEngine.gatewayName'))"
    >
      <UInput v-model="form.gatewayName" class="font-mono" />
    </UFormField>

    <UFormField
      v-if="form.urlSource === 'httpRouteStatus'"
      :label="optional(t('settings.infrastructure.kubernetesEngine.httpRouteName'))"
    >
      <UInput v-model="form.httpRouteName" class="font-mono" />
    </UFormField>

    <UFormField :label="optional(t('settings.infrastructure.kubernetesEngine.scheme'))">
      <USelect v-model="form.urlScheme" :items="schemeItems" />
    </UFormField>

    <!-- Optional refinements. -->
    <UFormField
      :label="optional(t('settings.infrastructure.kubernetesEngine.namespaceTemplate'))"
      :help="t('settings.infrastructure.kubernetesEngine.namespaceTemplateHelp')"
    >
      <UInput
        v-model="form.namespaceTemplate"
        class="font-mono"
        placeholder="cf-env-{{pullNumber}}"
      />
    </UFormField>

    <UFormField
      :label="optional(t('settings.infrastructure.kubernetesEngine.imageTemplate'))"
      :help="t('settings.infrastructure.kubernetesEngine.imageTemplateHelp')"
    >
      <UInput v-model="form.imageTemplate" class="font-mono" />
    </UFormField>

    <UFormField
      :label="optional(t('settings.infrastructure.kubernetesEngine.caCertPem'))"
      :help="t('settings.infrastructure.kubernetesEngine.caCertPemHelp')"
    >
      <UTextarea
        v-model="form.caCertPem"
        :rows="3"
        class="font-mono"
        placeholder="-----BEGIN CERTIFICATE-----"
      />
    </UFormField>

    <UFormField :help="t('settings.infrastructure.kubernetesEngine.insecureSkipTlsVerifyHelp')">
      <UCheckbox
        v-model="form.insecureSkipTlsVerify"
        :label="t('settings.infrastructure.kubernetesEngine.insecureSkipTlsVerify')"
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
        {{ connected ? t('common.save') : t('settings.providerConnection.form.connect') }}
      </UButton>
    </div>
  </div>
</template>
