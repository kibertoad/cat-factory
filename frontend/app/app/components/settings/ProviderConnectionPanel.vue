<script setup lang="ts">
// The generic connect form for the two infrastructure providers — the ephemeral-environment
// provider and the self-hosted runner pool. Both self-describe via a ProviderDescriptor
// (fields + defaults + the missingRequired keys still owed); this renders them without
// hard-coding either. A NATIVE provider also ships a `manifestTemplate`, so the flat fields
// are overlaid back onto a full manifest before saving (the single manifest storage path —
// see backend/docs/native-environment-adapter.md): a `secret` field → the write-only secret
// bundle, a non-secret field → providerConfig[key], a `baseUrl` field → baseUrl. A field
// with a `default` is optional — left blank it falls back to that default.
import { computed, ref, watch } from 'vue'
import type { ProviderConnectionKind } from '~/types/providerConnections'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const ui = useUiStore()
const store = useProviderConnectionsStore()
const toast = useToast()

const META: Record<ProviderConnectionKind, { title: string; icon: string; blurb: string }> = {
  environment: {
    title: 'Ephemeral environment provider',
    icon: 'i-lucide-cloud',
    blurb:
      'Where the Tester agent runs against a live preview environment. Configure the per-workspace settings and credentials your provider needs.',
  },
  'runner-pool': {
    title: 'Self-hosted runner pool',
    icon: 'i-lucide-server-cog',
    blurb:
      'Where the coding agents run when not using Cloudflare Containers. Configure the pool scheduler endpoint and credentials.',
  },
}

const kind = computed<ProviderConnectionKind | null>(() => ui.providerConnectionKind)
const open = computed({
  get: () => kind.value !== null,
  set: (v: boolean) => {
    if (!v) ui.closeProviderConnection()
  },
})

const meta = computed(() => (kind.value ? META[kind.value] : null))
const descriptor = computed(() => (kind.value ? store.descriptorFor(kind.value) : null))
const connection = computed(() => (kind.value ? store.connectionFor(kind.value) : null))

// Per-field draft values, keyed by field key (blank ⇒ fall back to default/stored value).
const values = ref<Record<string, string>>({})
const testResult = ref<{ ok: boolean; message?: string } | null>(null)
const testing = ref(false)
const busy = ref(false)

// Seed the draft from the saved manifest so an edit starts from the CURRENT non-secret config
// (baseUrl + providerConfig) rather than blanks — re-saving then re-sends it instead of
// dropping it. Secret fields are never prefilled (write-only); they must be re-entered to save.
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

watch(
  kind,
  (k) => {
    if (k) void store.loadKind(k).then(resetDraft)
  },
  { immediate: true },
)

/** A native provider ships a manifest scaffold ⇒ we can author/register the full manifest. */
const canAuthor = computed(() => !!descriptor.value?.manifestTemplate)
const secretFieldCount = computed(
  () => (descriptor.value?.configFields ?? []).filter((f) => f.secret).length,
)
const hasSecretFields = computed(() => secretFieldCount.value > 0)
/** Already-configured manifest provider: we can still rotate its secrets. */
const canRotateSecrets = computed(() => !canAuthor.value && !!connection.value)

/** A field is satisfied when filled now, or already stored, or it has a default. */
function satisfied(key: string): boolean {
  const f = descriptor.value?.configFields.find((cf) => cf.key === key)
  if (!f) return true
  if ((values.value[key] ?? '').trim()) return true
  if (f.default !== undefined) return true
  return !(descriptor.value?.missingRequired ?? []).includes(key)
}

/** Save is allowed once every required-without-default key is supplied. */
const canSave = computed(() => {
  if (!descriptor.value) return false
  if (!canAuthor.value && !canRotateSecrets.value) return false
  return (descriptor.value.missingRequired ?? []).every(satisfied)
})

/**
 * Overlay the flat field values onto the provider's manifest. We base the overlay on the
 * CURRENT saved manifest when one exists (so previously-stored providerConfig — including
 * nested values the flat form doesn't render — survives a re-save), falling back to the bare
 * `manifestTemplate` scaffold on a first connect. Native providers only (a manifest provider
 * has no template ⇒ null, and rotates secrets via the dedicated path instead).
 */
function buildManifestPayload(): {
  manifest: Record<string, unknown>
  secrets: Record<string, string>
} | null {
  const template = descriptor.value?.manifestTemplate
  if (!template) return null
  const base = descriptor.value?.savedManifest ?? template
  // `base` is a Vue reactive proxy, which structuredClone refuses (DataCloneError). The
  // manifest is plain JSON config, so a JSON round-trip both unwraps the proxy and deep-clones.
  const manifest: Record<string, unknown> = JSON.parse(JSON.stringify(base))
  const providerConfig: Record<string, unknown> = {
    ...(manifest.providerConfig as Record<string, unknown> | undefined),
  }
  const secrets: Record<string, string> = {}
  for (const f of descriptor.value?.configFields ?? []) {
    const val = (values.value[f.key] ?? '').trim()
    if (!val) continue // omit ⇒ falls back to the scaffold default
    if (f.secret) secrets[f.key] = val
    else if (f.key === 'baseUrl') manifest.baseUrl = val
    else providerConfig[f.key] = val
  }
  if (Object.keys(providerConfig).length) manifest.providerConfig = providerConfig
  return { manifest, secrets }
}

/** Just the secret-field values (for rotating an authored manifest provider's secrets). */
function buildSecretsOnly(): Record<string, string> {
  const secrets: Record<string, string> = {}
  for (const f of descriptor.value?.configFields ?? []) {
    if (!f.secret) continue
    const val = (values.value[f.key] ?? '').trim()
    if (val) secrets[f.key] = val
  }
  return secrets
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function test() {
  if (!kind.value) return
  const payload = buildManifestPayload()
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await store.test(kind.value, payload ?? { secrets: buildSecretsOnly() })
  } catch (e) {
    testResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

async function save() {
  if (!kind.value) return
  busy.value = true
  try {
    if (canAuthor.value) {
      const payload = buildManifestPayload()
      if (payload) await store.register(kind.value, payload)
    } else {
      await store.updateSecrets(kind.value, buildSecretsOnly())
    }
    resetDraft()
    toast.add({ title: `${meta.value?.title} saved`, icon: 'i-lucide-check', color: 'success' })
  } catch (e) {
    notifyError('Could not save the connection', e)
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (!kind.value) return
  busy.value = true
  try {
    await store.remove(kind.value)
    resetDraft()
    toast.add({ title: 'Connection removed', icon: 'i-lucide-check' })
  } catch (e) {
    notifyError('Could not remove the connection', e)
  } finally {
    busy.value = false
  }
}

/** The helper line under a field — its own help, plus the "defaulted to …" hint. */
function fieldHelp(key: string): string | undefined {
  const f = descriptor.value?.configFields.find((cf) => cf.key === key)
  if (!f) return undefined
  const filled = (values.value[key] ?? '').trim()
  if (f.default !== undefined && !filled) {
    return f.help ? `${f.help} · Defaults to ${f.default}` : `Defaults to ${f.default}`
  }
  return f.help
}
</script>

<template>
  <UModal v-model:open="open" :title="meta?.title ?? 'Provider'" :ui="{ content: 'max-w-xl' }">
    <template #title>
      <IntegrationBackTitle
        :title="meta?.title ?? 'Provider'"
        @back="
          open = false
          ui.openIntegrations()
        "
      />
    </template>
    <template #body>
      <div v-if="descriptor" class="space-y-4">
        <p class="text-xs text-slate-400">{{ meta?.blurb }}</p>

        <!-- Saved connection summary -->
        <div
          v-if="connection"
          class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
        >
          <div>
            <span class="font-medium text-slate-200">{{ connection.label }}</span>
            <div class="text-[11px] text-emerald-400">Connected · {{ connection.baseUrl }}</div>
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
          Missing required config: {{ descriptor.missingRequired.join(', ') }}
        </div>

        <!-- Generic, descriptor-driven field form -->
        <div
          v-if="canAuthor || canRotateSecrets"
          class="rounded-lg border border-dashed border-slate-700 p-3 space-y-3"
        >
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ connection ? 'Update configuration' : 'Connect' }}
          </p>
          <!-- A native re-register replaces the whole manifest; secrets are write-only so they
               must be re-supplied. Non-secret config is prefilled, so it survives a save. -->
          <p
            v-if="connection && canAuthor && hasSecretFields"
            class="text-[11px] text-amber-300/80"
          >
            Re-enter the secret field{{ secretFieldCount > 1 ? 's' : '' }} to save changes — stored
            secrets are write-only and aren't shown.
          </p>

          <UFormField
            v-for="field in descriptor.configFields"
            :key="field.key"
            :label="
              field.label + (field.required && field.default === undefined ? '' : ' (optional)')
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
              @click="test()"
            >
              Test connection
            </UButton>
            <span v-if="testResult && testResult.ok" class="text-xs text-emerald-400">
              {{ testResult.message ?? 'Connection OK' }}
            </span>
            <span v-else-if="testResult" class="text-xs text-rose-400">
              {{ testResult.message ?? 'Connection failed' }}
            </span>
          </div>

          <div class="flex justify-end">
            <UButton color="primary" size="sm" :loading="busy" :disabled="!canSave" @click="save()">
              {{ connection ? 'Save' : 'Connect' }}
            </UButton>
          </div>
        </div>

        <!-- Manifest provider with nothing to overlay onto: needs the manifest editor -->
        <div
          v-else
          class="rounded-md border border-slate-700 bg-slate-900/40 px-3 py-3 text-xs text-slate-400"
        >
          This provider is configured by authoring a manifest. The in-app manifest editor isn't
          available yet — register it via the API for now.
        </div>
      </div>
    </template>
  </UModal>
</template>
