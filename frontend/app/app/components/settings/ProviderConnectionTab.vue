<script setup lang="ts">
// One tab of the Infrastructure window — the connect surface for a single provider kind
// (container agents → runner pool, or test environments → environment provider). Both
// self-describe via a ProviderDescriptor, so this renders every backend WITHOUT hard-coding
// which optional kinds (Kubernetes, EKS, a custom kind) exist:
//   - a NATIVE MANIFEST provider (ships a `manifestTemplate`) → the flat field form, whose
//     values are overlaid back onto the manifest before saving.
//   - a NATIVE CONFIG backend (ships a `configTemplate` — the runner backends Kubernetes/EKS
//     and any custom native kind) → the SAME flat field form, whose values are overlaid onto
//     the discriminated `{ kind, <payload> }` config the backend described. The SPA never
//     names a backend; it reads the single payload key off the skeleton.
//   - a MANIFEST-driven provider (no template) → the full JSON manifest editor
//     (ProviderManifestEditor), which replaces the old "use the API" disclaimer.
import { computed, ref, toRaw, watch } from 'vue'
import type { ProviderConfigField, ProviderConnectionKind } from '~/types/providerConnections'
import ProvisioningLogsDrawer from '~/components/provisioning/ProvisioningLogsDrawer.vue'
import ProviderManifestEditor from '~/components/settings/ProviderManifestEditor.vue'
import KubernetesEnvironmentForm from '~/components/settings/KubernetesEnvironmentForm.vue'

const props = defineProps<{
  kind: ProviderConnectionKind
  /** The selected backend-kind slug — chosen by the parent picker's radio, not a local
   *  dropdown. Built-in (`manifest`/`kubernetes`) or a deployment-registered custom kind. */
  backendKind: string
  /** A low-config preset to prefill the Kubernetes form (today: local k3s). */
  preset?: 'k3s'
  /** The deployment's executor image, used to prefill the k3s preset's image field. */
  suggestedImage?: string
}>()

const emit = defineEmits<{ connected: [] }>()

const { t } = useI18n()
const store = useProviderConnectionsStore()
const toast = useToast()

const descriptor = computed(() => store.descriptorFor(props.kind))
const connection = computed(() => store.connectionFor(props.kind))

const BLURB_KEYS: Record<ProviderConnectionKind, string> = {
  environment: 'settings.providerConnection.kind.environment.blurb',
  'runner-pool': 'settings.providerConnection.kind.runner-pool.blurb',
}
const blurb = computed(() => t(BLURB_KEYS[props.kind]))
const title = computed(() => t(`settings.providerConnection.kind.${props.kind}.title`))

watch(
  () => props.kind,
  (k) => void store.loadKind(k, props.backendKind).then(resetDraft),
  { immediate: true },
)

// "View logs": the provisioning event history for this provider's subsystem.
const showLogs = ref(false)

// --- Shared state -------------------------------------------------------------------
const values = ref<Record<string, string>>({})
const testResult = ref<{ ok: boolean; message?: string } | null>(null)
const testing = ref(false)
const busy = ref(false)

// A native provider renders the friendly flat field form. Two flavours self-describe it:
// `manifestTemplate` (overlay onto a manifest) and `configTemplate` (overlay onto a
// discriminated backend config — the Kubernetes/EKS/custom runner backends).
const isNativeManifest = computed(() => !!descriptor.value?.manifestTemplate)
const isNativeConfig = computed(() => !!descriptor.value?.configTemplate)
const isNative = computed(() => isNativeManifest.value || isNativeConfig.value)
const secretFieldCount = computed(
  () => (descriptor.value?.configFields ?? []).filter((f) => f.secret).length,
)
const hasSecretFields = computed(() => secretFieldCount.value > 0)

// Seed the flat-form draft from the CURRENT non-secret config so an edit starts populated.
// Secret fields are never prefilled. A `configTemplate` backend gets its flat values straight
// from `descriptor.values`; a `manifestTemplate` backend reads them off the saved manifest
// (baseUrl + providerConfig). On a fresh Kubernetes connect a `k3s` preset prefills local defaults.
function resetDraft() {
  testResult.value = null
  if (isNativeConfig.value) {
    values.value = { ...descriptor.value?.values }
    applyPresetDefaults()
    return
  }
  const saved = descriptor.value?.savedManifest
  const cfg = (saved?.providerConfig as Record<string, unknown> | undefined) ?? {}
  const next: Record<string, string> = {}
  for (const f of descriptor.value?.configFields ?? []) {
    if (f.secret) continue
    if (f.key === 'baseUrl') {
      const b = saved?.baseUrl ?? connection.value?.baseUrl
      if (typeof b === 'string') next[f.key] = b
    } else if (typeof cfg[f.key] === 'string') {
      next[f.key] = cfg[f.key] as string
    }
  }
  values.value = next
}

// The low-config `k3s` preset (an execution-axis radio the picker synthesises) prefills the
// local-cluster defaults into the generic Kubernetes runner form. Only on a FRESH connect —
// never clobbering a stored connection's values. Kept SPA-local because the preset is a UI
// affordance of the picker, not a backend concept.
function applyPresetDefaults() {
  if (props.preset !== 'k3s' || connection.value) return
  const seed: Record<string, string> = {
    label: 'Local k3s',
    apiServerUrl: 'https://127.0.0.1:6443',
    namespace: 'cat-factory',
    insecureSkipTlsVerify: 'true',
  }
  if (props.suggestedImage) seed.image = props.suggestedImage
  for (const [k, val] of Object.entries(seed)) {
    if (!(values.value[k] ?? '').trim()) values.value[k] = val
  }
}

/** A flat-form field is satisfied when filled now, or already stored, or it has a default. */
function satisfied(key: string): boolean {
  const f = descriptor.value?.configFields.find((cf) => cf.key === key)
  if (!f) return true
  if ((values.value[key] ?? '').trim()) return true
  if (f.default !== undefined) return true
  return !(descriptor.value?.missingRequired ?? []).includes(key)
}

const canSave = computed(() => {
  if (!descriptor.value || !isNative.value) return false
  return (descriptor.value.missingRequired ?? []).every(satisfied)
})

/** Overlay the flat field values onto the native provider's manifest. */
function buildManifestPayload(): {
  manifest: Record<string, unknown>
  secrets: Record<string, string>
  backendKind: string
} | null {
  const template = descriptor.value?.manifestTemplate
  if (!template) return null
  const base = descriptor.value?.savedManifest ?? template
  // `base` is a Vue reactive proxy, which structuredClone refuses; `toRaw` unwraps it.
  const manifest: Record<string, unknown> = structuredClone(toRaw(base))
  const providerConfig: Record<string, unknown> = {
    ...(manifest.providerConfig as Record<string, unknown> | undefined),
  }
  const secrets: Record<string, string> = {}
  for (const f of descriptor.value?.configFields ?? []) {
    const val = (values.value[f.key] ?? '').trim()
    if (!val) continue
    if (f.secret) secrets[f.key] = val
    else if (f.key === 'baseUrl') manifest.baseUrl = val
    else providerConfig[f.key] = val
  }
  if (Object.keys(providerConfig).length) manifest.providerConfig = providerConfig
  // Carry the selected kind so a CUSTOM backend's flat-form save is tagged with its slug
  // (not silently wrapped into the built-in `manifest` backend).
  return { manifest, secrets, backendKind: props.backendKind }
}

/** Coerce a flat string form value to the JSON type the backend config expects for its field. */
function coerceFieldValue(field: ProviderConfigField, raw: string): unknown {
  if (field.type === 'number') return Number(raw)
  if (field.type === 'checkbox') return raw === 'true'
  return raw
}

/**
 * Overlay the flat field values onto a NATIVE backend's discriminated `configTemplate`. The
 * skeleton is `{ kind, <payload> }`, so every non-secret field is written to the single
 * non-`kind` payload key (typed via the field's `type`), each secret to the write-only bundle,
 * and a cleared field is dropped so it reverts to absent. Because the template is the STORED
 * config on an edit, advanced API-only keys the flat form never renders are preserved.
 */
function buildConfigPayload(): {
  config: Record<string, unknown>
  secrets: Record<string, string>
} | null {
  const template = descriptor.value?.configTemplate
  if (!template) return null
  const config: Record<string, unknown> = structuredClone(toRaw(template))
  const payloadKey = Object.keys(config).find((k) => k !== 'kind')
  if (!payloadKey) return null
  const payload: Record<string, unknown> = {
    ...(config[payloadKey] as Record<string, unknown> | undefined),
  }
  const secrets: Record<string, string> = {}
  for (const f of descriptor.value?.configFields ?? []) {
    const raw = (values.value[f.key] ?? '').trim()
    if (f.secret) {
      if (raw) secrets[f.key] = raw
      continue
    }
    if (!raw) delete payload[f.key]
    else payload[f.key] = coerceFieldValue(f, raw)
  }
  config[payloadKey] = payload
  return { config, secrets }
}

/** The payload for the active native flavour (discriminated config or manifest overlay). */
function buildFlatPayload() {
  return isNativeConfig.value ? buildConfigPayload() : buildManifestPayload()
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

function toastSaved() {
  toast.add({
    title: t('settings.providerConnection.toast.saved', { title: title.value }),
    icon: 'i-lucide-check',
    color: 'success',
  })
}

// --- Native flat-form actions (both manifest-overlay and config-overlay flavours) ---
async function testNative() {
  const payload = buildFlatPayload()
  if (!payload) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await store.test(props.kind, payload)
  } catch (e) {
    testResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

async function saveNative() {
  busy.value = true
  try {
    const payload = buildFlatPayload()
    if (payload) await store.register(props.kind, payload)
    emit('connected')
    resetDraft()
    toastSaved()
  } catch (e) {
    notifyError(t('settings.providerConnection.toast.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

// --- Manifest-editor actions (emitted from ProviderManifestEditor) ------------------
// Tag the raw-manifest save/test with the selected backend kind too, so a CUSTOM kind that
// ships no flat-form template (and thus uses the raw editor) isn't mis-tagged as `manifest`.
async function testManifest(payload: {
  manifest: Record<string, unknown>
  secrets: Record<string, string>
}) {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await store.test(props.kind, { ...payload, backendKind: props.backendKind })
  } catch (e) {
    testResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

async function saveManifest(payload: {
  manifest: Record<string, unknown>
  secrets: Record<string, string>
}) {
  busy.value = true
  try {
    await store.register(props.kind, { ...payload, backendKind: props.backendKind })
    emit('connected')
    toastSaved()
  } catch (e) {
    notifyError(t('settings.providerConnection.toast.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

// --- Backend connect forms ------------------------------------------------------------
// Which backend kind to configure (the built-in `manifest`/`kubernetes` backends or any
// CUSTOM kind a deployment registered) is decided by the parent picker's unified radio and
// passed in as `backendKind` — there is no longer a local dropdown here. The two K8s
// backends have bespoke forms; every other kind (manifest + custom) uses the descriptor-
// driven flat form / raw manifest editor. Switching the kind re-probes ONLY that kind's
// descriptor (so a not-yet-connected custom kind's connect form renders) WITHOUT re-fetching
// the stored connection — using `loadDescriptor` (not `loadKind`) avoids bouncing the
// picker's selection back to the stored kind via a connection re-read.
watch(
  () => props.backendKind,
  (k) => void store.loadDescriptor(props.kind, k).then(resetDraft),
)

async function testConfig(payload: {
  config: Record<string, unknown>
  secrets: Record<string, string>
}) {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await store.test(props.kind, payload)
  } catch (e) {
    testResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

async function saveConfig(payload: {
  config: Record<string, unknown>
  secrets: Record<string, string>
}) {
  busy.value = true
  try {
    await store.register(props.kind, payload)
    emit('connected')
    toastSaved()
  } catch (e) {
    notifyError(t('settings.providerConnection.toast.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

async function remove() {
  busy.value = true
  try {
    await store.remove(props.kind)
    resetDraft()
    toast.add({ title: t('settings.providerConnection.toast.removed'), icon: 'i-lucide-check' })
  } catch (e) {
    notifyError(t('settings.providerConnection.toast.removeFailed'), e)
  } finally {
    busy.value = false
  }
}

/** The helper line under a flat field — its own help, plus the "defaulted to …" hint. */
function fieldHelp(key: string): string | undefined {
  const f = descriptor.value?.configFields.find((cf) => cf.key === key)
  if (!f) return undefined
  const filled = (values.value[key] ?? '').trim()
  if (f.default !== undefined && !filled) {
    const defaulted = t('settings.providerConnection.field.defaultsTo', { value: f.default })
    return f.help ? `${f.help} · ${defaulted}` : defaulted
  }
  return f.help
}
</script>

<template>
  <div v-if="descriptor" class="space-y-4">
    <div class="flex items-start justify-between gap-3">
      <p class="text-xs text-slate-400">{{ blurb }}</p>
      <UButton
        :icon="showLogs ? 'i-lucide-chevron-up' : 'i-lucide-scroll-text'"
        variant="ghost"
        size="xs"
        class="shrink-0"
        @click="showLogs = !showLogs"
      >
        {{
          showLogs
            ? t('settings.providerConnection.hideLogs')
            : t('settings.providerConnection.viewLogs')
        }}
      </UButton>
    </div>

    <!-- Provisioning attempt history for this provider's subsystem. -->
    <ProvisioningLogsDrawer v-if="showLogs" :subsystem="kind" />

    <!-- Saved connection summary -->
    <div
      v-if="connection"
      class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
    >
      <div>
        <span class="font-medium text-slate-200">{{ connection.label }}</span>
        <div class="text-[11px] text-emerald-400">
          {{ t('settings.providerConnection.connectedAt', { baseUrl: connection.baseUrl }) }}
        </div>
      </div>
      <UButton
        icon="i-lucide-trash-2"
        color="error"
        variant="ghost"
        size="xs"
        :disabled="busy"
        @click="remove()"
      />
    </div>

    <!-- Mandatory-fields warning (mirrors the banner) -->
    <div
      v-if="descriptor.missingRequired.length"
      class="rounded-md border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
    >
      {{
        t('settings.providerConnection.missingConfig', {
          fields: descriptor.missingRequired.join(', '),
        })
      }}
    </div>

    <!-- Native Kubernetes ephemeral-environment backend (environment). The runner-pool
         Kubernetes/EKS backends now self-describe via `configTemplate` and render through the
         generic flat form below — no per-kind component. The env axis keeps its bespoke form
         until it, too, is descriptor-driven (see docs/initiatives/descriptor-driven-infra-forms.md). -->
    <KubernetesEnvironmentForm
      v-if="kind === 'environment' && backendKind === 'kubernetes'"
      :connection="connection"
      :supports-test="descriptor.supportsTest"
      :testing="testing"
      :busy="busy"
      :test-result="testResult"
      @test="testConfig"
      @save="saveConfig"
    />

    <!-- NATIVE provider: the friendly, descriptor-driven flat field form. -->
    <div
      v-else-if="isNative"
      class="rounded-lg border border-dashed border-slate-700 p-3 space-y-3"
    >
      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{
          connection
            ? t('settings.providerConnection.form.updateConfiguration')
            : t('settings.providerConnection.form.connect')
        }}
      </p>
      <p v-if="connection && hasSecretFields" class="text-[11px] text-amber-300/80">
        {{
          t(
            'settings.providerConnection.form.reenterSecrets',
            { count: secretFieldCount },
            secretFieldCount,
          )
        }}
      </p>

      <UFormField
        v-for="field in descriptor.configFields"
        :key="field.key"
        :label="
          field.required && field.default === undefined
            ? field.label
            : t('settings.providerConnection.form.optionalLabel', { label: field.label })
        "
        :help="fieldHelp(field.key)"
      >
        <USelect
          v-if="field.type === 'select'"
          v-model="values[field.key]"
          :items="(field.options ?? []).map((o) => ({ label: o.label, value: o.value }))"
          :placeholder="field.default ?? field.placeholder"
        />
        <USwitch
          v-else-if="field.type === 'checkbox'"
          :model-value="values[field.key] === 'true'"
          @update:model-value="values[field.key] = $event ? 'true' : 'false'"
        />
        <UTextarea
          v-else-if="field.type === 'textarea'"
          v-model="values[field.key]"
          :rows="4"
          class="w-full font-mono"
          :placeholder="field.default ?? field.placeholder"
        />
        <UInput
          v-else-if="field.type === 'number'"
          :model-value="values[field.key] ?? ''"
          type="number"
          class="font-mono"
          :placeholder="field.default ?? field.placeholder"
          @update:model-value="values[field.key] = String($event ?? '')"
        />
        <UInput
          v-else
          v-model="values[field.key]"
          :type="field.secret ? 'password' : 'text'"
          class="font-mono"
          :placeholder="field.default ?? field.placeholder"
        />
      </UFormField>

      <div v-if="descriptor.supportsTest" class="flex items-center gap-2">
        <UButton
          color="neutral"
          variant="soft"
          size="sm"
          icon="i-lucide-plug-zap"
          :loading="testing"
          @click="testNative()"
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
          @click="saveNative()"
        >
          {{ connection ? t('common.save') : t('settings.providerConnection.form.connect') }}
        </UButton>
      </div>
    </div>

    <!-- MANIFEST-driven provider: the raw JSON manifest editor. The radio already selected
         "custom HTTP" so it's shown expanded — no extra disclosure. -->
    <ProviderManifestEditor
      v-else
      :kind="kind"
      :saved-manifest="descriptor.savedManifest"
      :connected="!!connection"
      :stored-secret-keys="connection?.secretKeys ?? []"
      :supports-test="descriptor.supportsTest"
      :testing="testing"
      :busy="busy"
      :test-result="testResult"
      @test="testManifest"
      @save="saveManifest"
    />
  </div>
</template>
