<script setup lang="ts">
// The in-app manifest editor for a MANIFEST-DRIVEN infrastructure provider (a runner pool
// or an environment provider without a native code adapter). It replaces the old
// "register it via the API" disclaimer: the operator authors the provider's full JSON
// manifest here, supplies the write-only secret values it references, and tests/saves —
// entirely in-app.
//
// The manifest is validated against the SAME Valibot wire contract the backend enforces
// (runner pool: RunnerPoolManifest; environment: EnvironmentManifest), imported from
// @cat-factory/contracts so the client check stays in lockstep with the server. The server
// remains authoritative — register re-validates — so a client that's behind still can't
// persist an invalid manifest.
//
// Secrets are write-only: never prefilled. Because register replaces the whole manifest +
// secret bundle, EVERY secret key the manifest references must be (re-)supplied on save —
// on an existing connection the amber hint says so.
import { computed, ref, watch } from 'vue'
import * as v from 'valibot'
import { environmentManifestSchema, runnerPoolManifestSchema } from '@cat-factory/contracts'
import type { ProviderConnectionKind } from '~/types/providerConnections'

const props = defineProps<{
  kind: ProviderConnectionKind
  /** The provider's current saved manifest (secret-ref keys only, no values). */
  savedManifest?: Record<string, unknown>
  /** Whether a connection already exists (drives the re-enter-secrets hint + button label). */
  connected: boolean
  /** The secret keys already stored for this connection (names only) — shown next to the
   *  write-only inputs so it's obvious what exists without scrolling to the summary. */
  storedSecretKeys?: string[]
  /** Whether the provider exposes a connection test the UI can call. */
  supportsTest: boolean
  /** Bubbled-up busy state from the tab's store calls (so the editor shows loading). */
  testing: boolean
  busy: boolean
  testResult: { ok: boolean; message?: string } | null
}>()

const emit = defineEmits<{
  test: [payload: { manifest: Record<string, unknown>; secrets: Record<string, string> }]
  save: [payload: { manifest: Record<string, unknown>; secrets: Record<string, string> }]
}>()

const { t } = useI18n()

// A minimal, valid starter manifest per kind (O1 option a: a static SPA example — no backend
// round-trip). Seeds the editor when there's no saved manifest to start from. The operator
// edits providerId/label/baseUrl and the request templates for their own scheduler/API.
const STARTERS: Record<ProviderConnectionKind, Record<string, unknown>> = {
  'runner-pool': {
    providerId: 'my-pool',
    label: 'My runner pool',
    baseUrl: 'https://pool.example.com',
    auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
    dispatch: { method: 'POST', pathTemplate: '/jobs', bodyTemplate: '{{input.job}}' },
    poll: { method: 'GET', pathTemplate: '/jobs/{{input.jobId}}' },
    response: {
      statusPath: 'state',
      statusMap: [
        { from: 'running', to: 'running' },
        { from: 'completed', to: 'done' },
        { from: 'error', to: 'failed' },
      ],
      resultPath: 'result',
    },
  },
  environment: {
    providerId: 'my-envs',
    label: 'My environment provider',
    baseUrl: 'https://envs.example.com',
    auth: { type: 'bearer', secretRef: { key: 'API_TOKEN' } },
    provision: { method: 'POST', pathTemplate: '/environments', bodyTemplate: '{}' },
    status: { method: 'GET', pathTemplate: '/environments/{{provision.id}}' },
    teardown: { method: 'DELETE', pathTemplate: '/environments/{{provision.id}}' },
    response: {
      urlPath: 'url',
      statusPath: 'status',
      statusMap: [
        { from: 'building', to: 'provisioning' },
        { from: 'ready', to: 'ready' },
      ],
    },
  },
}

const schema = computed(() =>
  props.kind === 'runner-pool' ? runnerPoolManifestSchema : environmentManifestSchema,
)

const text = ref('')
const secrets = ref<Record<string, string>>({})

/** Seed the editor from the saved manifest (an edit) or the starter (a first connect). */
function seed() {
  const base = props.savedManifest ?? STARTERS[props.kind]
  text.value = JSON.stringify(base, null, 2)
  secrets.value = {}
}

// Re-seed on first mount and whenever the saved manifest changes (e.g. after a successful
// save reloads the descriptor) — the saved manifest is the new canonical text and the
// just-saved secrets are cleared from the write-only inputs.
watch(() => props.savedManifest, seed, { immediate: true })

/** Parse the textarea; null value on a JSON syntax error. */
const parsed = computed<{ ok: boolean; value?: Record<string, unknown> }>(() => {
  const raw = text.value.trim()
  if (!raw) return { ok: false }
  try {
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false }
    return { ok: true, value: value as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
})

const jsonError = computed(() => text.value.trim().length > 0 && !parsed.value.ok)

/** Validate the parsed object against the wire contract; surface the first issue. */
const schemaError = computed<string | null>(() => {
  if (!parsed.value.ok || !parsed.value.value) return null
  const result = v.safeParse(schema.value, parsed.value.value)
  if (result.success) return null
  const issue = result.issues[0]
  if (!issue) return t('settings.providerConnection.manifestEditor.invalidShape')
  const path = (issue.path ?? []).map((p) => String((p as { key?: unknown }).key ?? '')).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
})

const validManifest = computed<Record<string, unknown> | null>(() =>
  parsed.value.ok && parsed.value.value && !schemaError.value ? parsed.value.value : null,
)

/**
 * Every secret key the manifest's auth scheme references, discovered generically by walking
 * the parsed object for any `*SecretRef` (or `secretRef`) with a string `key`. Covers bearer
 * / api_key / basic / oauth2 / custom_headers without hard-coding each auth variant.
 */
const secretKeys = computed<string[]>(() => {
  const out = new Set<string>()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, val] of Object.entries(node)) {
        if (
          /secretref$/i.test(key) &&
          val &&
          typeof val === 'object' &&
          typeof (val as { key?: unknown }).key === 'string'
        ) {
          out.add((val as { key: string }).key)
        } else {
          walk(val)
        }
      }
    }
  }
  if (parsed.value.value) walk(parsed.value.value)
  return [...out]
})

// register() replaces the whole bundle, so every referenced secret must be supplied to save.
const allSecretsSupplied = computed(() =>
  secretKeys.value.every((k) => (secrets.value[k] ?? '').trim().length > 0),
)
const canSave = computed(() => !!validManifest.value && allSecretsSupplied.value)
// A test can probe with whatever secrets are filled in (a partial probe is still useful).
const canTest = computed(() => !!validManifest.value)

function filledSecrets(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of secretKeys.value) {
    const val = (secrets.value[k] ?? '').trim()
    if (val) out[k] = val
  }
  return out
}

function onTest() {
  if (!validManifest.value) return
  emit('test', { manifest: validManifest.value, secrets: filledSecrets() })
}

function onSave() {
  if (!canSave.value || !validManifest.value) return
  emit('save', { manifest: validManifest.value, secrets: filledSecrets() })
}
</script>

<template>
  <div class="space-y-3 rounded-lg border border-dashed border-slate-700 p-3">
    <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
      {{ t('settings.providerConnection.manifestEditor.title') }}
    </p>

    <UFormField
      :label="t('settings.providerConnection.manifestEditor.jsonLabel')"
      :help="t('settings.providerConnection.manifestEditor.jsonHelp')"
    >
      <UTextarea
        v-model="text"
        :rows="16"
        class="w-full font-mono text-xs"
        data-testid="manifest-editor-json"
        spellcheck="false"
      />
    </UFormField>

    <p v-if="!savedManifest && !jsonError && !schemaError" class="text-[11px] text-slate-500">
      {{ t('settings.providerConnection.manifestEditor.starterHint') }}
    </p>

    <!-- Parse + shape errors, validated against the same contract the backend enforces. -->
    <p
      v-if="jsonError"
      class="rounded-md border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-200"
      data-testid="manifest-editor-error"
    >
      {{ t('settings.providerConnection.manifestEditor.invalidJson') }}
    </p>
    <p
      v-else-if="schemaError"
      class="rounded-md border border-amber-500/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-200"
      data-testid="manifest-editor-error"
    >
      {{ t('settings.providerConnection.manifestEditor.schemaError', { message: schemaError }) }}
    </p>

    <!-- Secret sub-form: one write-only input per secret key the manifest references. -->
    <div class="space-y-2">
      <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {{ t('settings.providerConnection.manifestEditor.secretsLabel') }}
      </p>
      <p v-if="!secretKeys.length" class="text-[11px] text-slate-500">
        {{ t('settings.providerConnection.manifestEditor.noSecrets') }}
      </p>
      <template v-else-if="connected">
        <p
          v-if="storedSecretKeys && storedSecretKeys.length"
          class="text-[11px] text-slate-400"
          data-testid="manifest-editor-stored"
        >
          {{
            t('settings.providerConnection.manifestEditor.stored', {
              keys: storedSecretKeys.join(', '),
            })
          }}
        </p>
        <p class="text-[11px] text-amber-300/80">
          {{ t('settings.providerConnection.manifestEditor.reenterSecrets') }}
        </p>
      </template>
      <UFormField v-for="key in secretKeys" :key="key" :label="key">
        <UInput
          v-model="secrets[key]"
          type="password"
          class="w-full font-mono"
          autocomplete="off"
          :data-testid="`manifest-editor-secret-${key}`"
        />
      </UFormField>
    </div>

    <div v-if="supportsTest" class="flex items-center gap-2">
      <UButton
        color="neutral"
        variant="soft"
        size="sm"
        icon="i-lucide-plug-zap"
        :loading="testing"
        :disabled="!canTest"
        data-testid="manifest-editor-test"
        @click="onTest()"
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
        data-testid="manifest-editor-save"
        @click="onSave()"
      >
        {{ connected ? t('common.save') : t('settings.providerConnection.form.connect') }}
      </UButton>
    </div>
  </div>
</template>
