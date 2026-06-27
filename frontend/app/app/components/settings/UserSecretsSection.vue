<script setup lang="ts">
// Per-user settings: "My GitHub token" (and future per-user repository/provider secrets).
// A generic, descriptor-driven connect form: the backend declares each kind's fields
// (one secret + optional metadata) and whether a connection test is available; this
// renders them without hard-coding any kind. Stored PER USER (runs you initiate use YOUR
// access); the secret is write-only server-side and never shown again.
import { computed, ref, watch } from 'vue'
import type { ProviderConfigField, UserSecretKind } from '~/types/userSecrets'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const ui = useUiStore()
const store = useUserSecretsStore()
const toast = useToast()

const open = computed({
  get: () => ui.userSecretsOpen,
  set: (v: boolean) => (v ? ui.openUserSecrets() : ui.closeUserSecrets()),
})
const back = useIntegrationBack(open)

// The kind being edited (only `github_pat` today; descriptors drive the rest generically).
const kind = ref<UserSecretKind>('github_pat')
const descriptor = computed(() => store.descriptorFor(kind.value))
const status = computed(() => store.statusFor(kind.value))

// Per-field draft values, keyed by field key. The secret field maps to the wire `secret`;
// all other fields map into `metadata`.
const values = ref<Record<string, string>>({})
const labelDraft = ref('')
const testResult = ref<{ ok: boolean; message?: string } | null>(null)
const testing = ref(false)
const busy = ref(false)

function resetDraft() {
  values.value = {}
  labelDraft.value = ''
  testResult.value = null
  // Prefill non-secret metadata from the stored status (secret stays blank — write-only).
  const meta = status.value?.metadata
  if (meta) for (const [k, v] of Object.entries(meta)) values.value[k] = v
}

watch(
  open,
  (isOpen) => {
    if (isOpen) void store.load().then(resetDraft)
  },
  { immediate: true },
)
watch(kind, resetDraft)

const secretField = computed<ProviderConfigField | undefined>(() =>
  descriptor.value?.configFields.find((f) => f.secret),
)
const metadataFields = computed<ProviderConfigField[]>(() =>
  (descriptor.value?.configFields ?? []).filter((f) => !f.secret),
)

/** Build the wire payload: the secret field → `secret`, the rest → `metadata`. */
function buildPayload(): { secret: string; metadata?: Record<string, string> } | null {
  const sf = secretField.value
  if (!sf) return null
  const secret = (values.value[sf.key] ?? '').trim()
  if (!secret) return null
  const metadata: Record<string, string> = {}
  for (const f of metadataFields.value) {
    const v = (values.value[f.key] ?? '').trim()
    if (v) metadata[f.key] = v
  }
  return { secret, ...(Object.keys(metadata).length ? { metadata } : {}) }
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
  const payload = buildPayload()
  if (!payload) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await store.test(kind.value, payload)
  } catch (e) {
    testResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

async function save() {
  const payload = buildPayload()
  if (!payload) return
  busy.value = true
  try {
    await store.store(kind.value, { ...payload, label: labelDraft.value.trim() || undefined })
    values.value[secretField.value!.key] = ''
    testResult.value = null
    toast.add({
      title: `${descriptor.value?.label ?? 'Secret'} saved`,
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError('Could not save secret', e)
  } finally {
    busy.value = false
  }
}

async function remove() {
  busy.value = true
  try {
    await store.remove(kind.value)
    resetDraft()
    toast.add({ title: 'Secret removed', icon: 'i-lucide-check' })
  } catch (e) {
    notifyError('Could not remove secret', e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="My GitHub token" :ui="{ content: 'max-w-xl' }">
    <template #title>
      <IntegrationBackTitle title="My GitHub token" @back="back" />
    </template>
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-slate-400">
          Store a personal access token used for the runs <strong>you</strong> start — pushes, pull
          requests, the CI gate and merges are attributed to your GitHub access. Stored
          <span class="text-slate-300">just for you</span>; the token is write-only and never shown
          again.
        </p>

        <div
          v-if="status"
          class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
        >
          <div>
            <span class="font-medium text-slate-200">{{ status.label }}</span>
            <div class="text-[11px] text-emerald-400">Connected · token stored</div>
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

        <div
          v-if="descriptor"
          class="rounded-lg border border-dashed border-slate-700 p-3 space-y-3"
        >
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{ status ? 'Replace token' : 'Add a token' }}
          </p>

          <UFormField label="Label (optional)">
            <UInput v-model="labelDraft" :placeholder="descriptor.label" />
          </UFormField>

          <UFormField
            v-for="field in descriptor.configFields"
            :key="field.key"
            :label="field.label + (field.required ? '' : ' (optional)')"
            :help="field.help"
          >
            <UInput
              v-model="values[field.key]"
              :type="field.secret ? 'password' : 'text'"
              class="font-mono"
              :placeholder="field.placeholder"
            />
          </UFormField>

          <div v-if="descriptor.supportsTest" class="flex items-center gap-2">
            <UButton
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-plug-zap"
              :loading="testing"
              :disabled="!buildPayload()"
              @click="test()"
            >
              Test connection
            </UButton>
            <span v-if="testResult && testResult.ok" class="text-xs text-emerald-400">
              {{ testResult.message ?? 'Token valid' }}
            </span>
            <span v-else-if="testResult" class="text-xs text-rose-400">
              {{ testResult.message ?? 'Token rejected' }}
            </span>
          </div>

          <div class="flex justify-end">
            <UButton
              color="primary"
              size="sm"
              :loading="busy"
              :disabled="!buildPayload()"
              @click="save()"
            >
              {{ status ? 'Save' : 'Add token' }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
