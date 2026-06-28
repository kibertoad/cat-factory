<script setup lang="ts">
// Per-user settings: "My GitHub token" (and future per-user repository/provider secrets).
// A generic, descriptor-driven connect form: the backend declares each kind's fields
// (one secret + optional metadata) and whether a connection test is available; this
// renders them without hard-coding any kind. Stored PER USER (runs you initiate use YOUR
// access); the secret is write-only server-side and never shown again.
import { computed, ref, watch } from 'vue'
import type { ProviderConfigField, UserSecretKind } from '~/types/userSecrets'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const { t } = useI18n()
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
      title: t('settings.userSecrets.toast.saved', {
        label: descriptor.value?.label ?? t('settings.userSecrets.secretFallback'),
      }),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.userSecrets.toast.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

async function remove() {
  busy.value = true
  try {
    await store.remove(kind.value)
    resetDraft()
    toast.add({ title: t('settings.userSecrets.toast.removed'), icon: 'i-lucide-check' })
  } catch (e) {
    notifyError(t('settings.userSecrets.toast.removeFailed'), e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('settings.userSecrets.title')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #title>
      <IntegrationBackTitle :title="t('settings.userSecrets.title')" @back="back" />
    </template>
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-slate-400">
          <i18n-t keypath="settings.userSecrets.intro" tag="span" scope="global">
            <template #you>
              <strong>{{ t('settings.userSecrets.introYou') }}</strong>
            </template>
            <template #scope>
              <span class="text-slate-300">{{ t('settings.userSecrets.introScope') }}</span>
            </template>
          </i18n-t>
        </p>

        <div
          v-if="status"
          class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
        >
          <div>
            <span class="font-medium text-slate-200">{{ status.label }}</span>
            <div class="text-[11px] text-emerald-400">
              {{ t('settings.userSecrets.connectedStored') }}
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

        <div
          v-if="descriptor"
          class="rounded-lg border border-dashed border-slate-700 p-3 space-y-3"
        >
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{
              status ? t('settings.userSecrets.replaceToken') : t('settings.userSecrets.addToken')
            }}
          </p>

          <UFormField :label="t('settings.userSecrets.labelField')">
            <UInput v-model="labelDraft" :placeholder="descriptor.label" />
          </UFormField>

          <UFormField
            v-for="field in descriptor.configFields"
            :key="field.key"
            :label="
              field.required
                ? field.label
                : t('settings.userSecrets.optionalField', { label: field.label })
            "
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
              {{ t('settings.userSecrets.testConnection') }}
            </UButton>
            <span v-if="testResult && testResult.ok" class="text-xs text-emerald-400">
              {{ testResult.message ?? t('settings.userSecrets.tokenValid') }}
            </span>
            <span v-else-if="testResult" class="text-xs text-rose-400">
              {{ testResult.message ?? t('settings.userSecrets.tokenRejected') }}
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
              {{ status ? t('common.save') : t('settings.userSecrets.addToken') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
