<script setup lang="ts">
// One tab of the Infrastructure window — the connect surface for a single provider kind
// (container agents → runner pool, or test environments → environment provider). Both
// self-describe via a ProviderDescriptor, so this renders either without hard-coding them:
//   - a NATIVE provider (ships a `manifestTemplate`) → the friendly flat field form, whose
//     values are overlaid back onto the manifest before saving (the single storage path).
//   - a MANIFEST-driven provider (no template) → the full JSON manifest editor
//     (ProviderManifestEditor), which replaces the old "use the API" disclaimer.
import { computed, ref, toRaw, watch } from 'vue'
import type { ProviderConnectionKind } from '~/types/providerConnections'
import ProvisioningLogsDrawer from '~/components/provisioning/ProvisioningLogsDrawer.vue'
import ProviderManifestEditor from '~/components/settings/ProviderManifestEditor.vue'
import KubernetesRunnerForm from '~/components/settings/KubernetesRunnerForm.vue'

const props = defineProps<{ kind: ProviderConnectionKind }>()

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
  (k) => void store.loadKind(k).then(resetDraft),
  { immediate: true },
)

// "View logs": the provisioning event history for this provider's subsystem.
const showLogs = ref(false)

// --- Shared state -------------------------------------------------------------------
const values = ref<Record<string, string>>({})
const testResult = ref<{ ok: boolean; message?: string } | null>(null)
const testing = ref(false)
const busy = ref(false)

/** A native provider ships a manifest scaffold ⇒ render the friendly flat field form. */
const isNative = computed(() => !!descriptor.value?.manifestTemplate)
const secretFieldCount = computed(
  () => (descriptor.value?.configFields ?? []).filter((f) => f.secret).length,
)
const hasSecretFields = computed(() => secretFieldCount.value > 0)

// Seed the flat-form draft from the saved manifest so an edit starts from the CURRENT
// non-secret config (baseUrl + providerConfig). Secret fields are never prefilled.
function resetDraft() {
  testResult.value = null
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
  return { manifest, secrets }
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

// --- Native flat-form actions -------------------------------------------------------
async function testNative() {
  const payload = buildManifestPayload()
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
    const payload = buildManifestPayload()
    if (payload) await store.register(props.kind, payload)
    resetDraft()
    toastSaved()
  } catch (e) {
    notifyError(t('settings.providerConnection.toast.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

// --- Manifest-editor actions (emitted from ProviderManifestEditor) ------------------
async function testManifest(payload: {
  manifest: Record<string, unknown>
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

async function saveManifest(payload: {
  manifest: Record<string, unknown>
  secrets: Record<string, string>
}) {
  busy.value = true
  try {
    await store.register(props.kind, payload)
    toastSaved()
  } catch (e) {
    notifyError(t('settings.providerConnection.toast.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

// --- Runner-backend selector (runner-pool only) -------------------------------------
// The runner-pool tab can configure either the manifest pool OR a native Kubernetes
// cluster; environments are manifest-only. Defaults to the saved connection's kind.
const RUNNER_BACKEND_KINDS = ['manifest', 'kubernetes'] as const
type RunnerBackendKind = (typeof RUNNER_BACKEND_KINDS)[number]
const backendKind = ref<RunnerBackendKind>('manifest')
const showBackendSelector = computed(() => props.kind === 'runner-pool')
const backendKindItems = computed(() =>
  RUNNER_BACKEND_KINDS.map((k) => ({
    label: t(`settings.providerConnection.backend.${k}`),
    value: k,
  })),
)
watch(
  () => connection.value,
  (c) => {
    if (c?.kind === 'kubernetes' || c?.kind === 'manifest') backendKind.value = c.kind
  },
  { immediate: true },
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

    <!-- Runner-backend selector: the manifest pool or a native Kubernetes cluster. -->
    <UFormField
      v-if="showBackendSelector"
      :label="t('settings.providerConnection.backend.selectorLabel')"
    >
      <USelect v-model="backendKind" :items="backendKindItems" />
    </UFormField>

    <!-- Native Kubernetes runner backend. -->
    <KubernetesRunnerForm
      v-if="showBackendSelector && backendKind === 'kubernetes'"
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

    <!-- MANIFEST-driven provider: the full in-app manifest editor. -->
    <ProviderManifestEditor
      v-else
      :kind="kind"
      :saved-manifest="descriptor.savedManifest"
      :connected="!!connection"
      :supports-test="descriptor.supportsTest"
      :testing="testing"
      :busy="busy"
      :test-result="testResult"
      @test="testManifest"
      @save="saveManifest"
    />
  </div>
</template>
