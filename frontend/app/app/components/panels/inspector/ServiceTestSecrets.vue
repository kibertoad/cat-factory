<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { Block } from '~/types/domain'
import InspectorSection from '~/components/panels/inspector/InspectorSection.vue'
import SecretInput from '~/components/common/SecretInput.vue'

// Per-service (frame) SENSITIVE test credentials: a genuinely secret token a Tester needs
// to exercise a third-party integration (e.g. a Stripe API key). Unlike the non-sensitive
// pools, these are SEALED at rest and injected into the Tester container OUT OF BAND — never
// rendered into a prompt or the telemetry snapshot. Keyed by THIS frame's block id.
//
// The backend stores the WHOLE set and values are write-only (never read back), so this is a
// full-set replace editor: saving persists exactly the rows below and drops anything omitted.
// The list prefills from the configured keys/descriptions; every value must be (re-)entered,
// and Save stays disabled until each row has one — so an existing secret can never be blanked
// by accident. Hidden entirely when the backend store is unconfigured (no ENCRYPTION_KEY).
const props = defineProps<{ block: Block }>()

const store = useTestSecretsStore()
const toast = useToast()
const { t } = useI18n()
const { confirmAction, toastDone } = useConfirmAction()

const busy = ref(false)

interface DraftRow {
  key: string
  description: string
  value: string
}
const draft = reactive<{ rows: DraftRow[] }>({ rows: [] })

const configured = computed(() => store.entriesForBlock(props.block.id))
const available = computed(() => store.available !== false)

const blankRow = (): DraftRow => ({ key: '', description: '', value: '' })

// Load this frame's configured refs once, then (re)hydrate the editor from them. Runs again
// after a save/clear (the store refs change) so the just-typed secret values don't linger in
// the form — the persisted set is re-shown with empty value fields to re-enter.
onMounted(() => {
  store.ensureLoaded(props.block.id).catch(() => {})
})
watch(
  configured,
  (entries) => {
    draft.rows = entries.length
      ? entries.map((e) => ({ key: e.key, description: e.description, value: '' }))
      : [blankRow()]
  },
  { immediate: true },
)

// A valid POSIX env-var name (mirrors the contract's testSecretKeySchema regex + max length).
// The reserved/toolchain-name rejection lives server-side and surfaces as a save error — we
// don't duplicate the harness's reserved-name list here.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const KEY_MAX = 128
function keyValid(key: string): boolean {
  const k = key.trim()
  return KEY_RE.test(k) && k.length <= KEY_MAX
}

// Keys that appear more than once (trimmed) — flagged inline and block saving.
const duplicateKeys = computed(() => {
  const seen = new Map<string, number>()
  for (const r of draft.rows) {
    const k = r.key.trim()
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k))
})

function rowComplete(r: DraftRow): boolean {
  return keyValid(r.key) && r.value.trim().length > 0
}

const canSave = computed(
  () =>
    !busy.value &&
    draft.rows.length > 0 &&
    draft.rows.every(rowComplete) &&
    duplicateKeys.value.size === 0,
)

function addRow() {
  draft.rows.push(blankRow())
}
function removeRow(index: number) {
  draft.rows.splice(index, 1)
}

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function save() {
  busy.value = true
  try {
    await store.save(props.block.id, {
      entries: draft.rows.map((r) => ({
        key: r.key.trim(),
        description: r.description.trim(),
        value: r.value,
      })),
    })
    toast.add({
      title: t('inspector.testSecrets.savedToast'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('inspector.testSecrets.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

async function clearAll() {
  const noun = t('inspector.testSecrets.configNoun')
  if (!(await confirmAction('clear', noun))) return
  busy.value = true
  try {
    await store.clear(props.block.id)
    toastDone('clear', noun)
  } catch (e) {
    notifyError(t('inspector.testSecrets.clearFailed'), e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <InspectorSection
    v-if="available"
    :title="t('inspector.testSecrets.title')"
    :hint="t('inspector.testSecrets.sectionHint')"
    :count="configured.length"
    warning
    default-open
    data-testid="service-test-secrets"
  >
    <template #actions>
      <UButton
        v-if="configured.length"
        color="error"
        variant="ghost"
        size="xs"
        icon="i-lucide-trash-2"
        :loading="busy"
        data-testid="test-secrets-clear"
        @click="clearAll"
      >
        {{ t('inspector.testSecrets.clear') }}
      </UButton>
    </template>

    <!-- These are REAL secrets: an unmistakable sensitivity + replace-all warning. -->
    <div
      class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-200"
    >
      <UIcon name="i-lucide-shield-alert" class="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
      <span>{{ t('inspector.testSecrets.warning') }}</span>
    </div>

    <p class="text-[11px] leading-snug text-slate-500">
      {{ t('inspector.testSecrets.replaceNote') }}
    </p>

    <div class="space-y-3">
      <div
        v-for="(row, index) in draft.rows"
        :key="index"
        class="space-y-2 rounded-md border border-slate-800 p-2.5"
        :data-testid="`test-secret-row-${index}`"
      >
        <div class="flex items-start gap-2">
          <UFormField
            :label="t('inspector.testSecrets.key')"
            :error="
              row.key.trim() && !keyValid(row.key)
                ? t('inspector.testSecrets.keyInvalid')
                : undefined
            "
            class="flex-1"
          >
            <UInput
              v-model="row.key"
              placeholder="STRIPE_API_KEY"
              size="sm"
              class="w-full font-mono"
              :data-testid="`test-secret-key-${index}`"
            />
          </UFormField>
          <UButton
            color="error"
            variant="ghost"
            size="xs"
            icon="i-lucide-x"
            class="mt-5 shrink-0"
            :aria-label="t('inspector.testSecrets.removeRow')"
            :data-testid="`test-secret-remove-${index}`"
            @click="removeRow(index)"
          />
        </div>

        <UFormField :label="t('inspector.testSecrets.description')">
          <UInput
            v-model="row.description"
            :placeholder="t('inspector.testSecrets.descriptionPlaceholder')"
            size="sm"
            class="w-full"
            :data-testid="`test-secret-description-${index}`"
          />
        </UFormField>

        <UFormField :label="t('inspector.testSecrets.value')">
          <SecretInput
            v-model="row.value"
            :placeholder="t('inspector.testSecrets.valuePlaceholder')"
            size="sm"
            class="w-full"
            :data-testid="`test-secret-value-${index}`"
          />
        </UFormField>
      </div>

      <p v-if="duplicateKeys.size" class="text-[11px] text-error-400">
        {{ t('inspector.testSecrets.duplicateKey') }}
      </p>

      <div class="flex items-center justify-between gap-2">
        <UButton
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-plus"
          data-testid="test-secret-add"
          @click="addRow"
        >
          {{ t('inspector.testSecrets.addRow') }}
        </UButton>
        <UButton
          color="primary"
          variant="soft"
          size="xs"
          icon="i-lucide-save"
          :loading="busy"
          :disabled="!canSave"
          data-testid="test-secrets-save"
          @click="save"
        >
          {{ t('inspector.testSecrets.save') }}
        </UButton>
      </div>
    </div>
  </InspectorSection>
</template>
