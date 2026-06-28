<script setup lang="ts">
// Per-user settings: "My local runners" — the signed-in user's own-machine LLM endpoints
// (Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible server). A runner lives on
// a person's box, so these are stored per-user (not pooled). Pick a runner type (prefills the
// default base URL), optionally a bearer key, then "Test connection" to discover the models it
// serves and tick which to enable. Save persists the endpoint; the enabled models then surface
// automatically in the per-workspace model picker. One endpoint per runner type.
import { computed, ref, watch } from 'vue'
import { LOCAL_RUNNER_DEFAULTS, LOCAL_RUNNER_LABELS, type LocalRunner } from '~/types/localModels'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'

const { t } = useI18n()
const ui = useUiStore()
const store = useLocalModelsStore()
const toast = useToast()

const open = computed({
  get: () => ui.localModelsOpen,
  set: (v: boolean) => (v ? ui.openLocalModels() : ui.closeLocalModels()),
})
const back = useIntegrationBack(open)

// Load the user's endpoints whenever the panel opens (loaded independently of the
// workspace snapshot, like personal subscriptions).
watch(
  open,
  (isOpen) => {
    if (isOpen) void store.load()
  },
  { immediate: true },
)

const RUNNERS: { value: LocalRunner; label: string }[] = (
  Object.keys(LOCAL_RUNNER_LABELS) as LocalRunner[]
).map((value) => ({ value, label: LOCAL_RUNNER_LABELS[value] }))

// ---- add / edit draft ------------------------------------------------------
const provider = ref<LocalRunner>('ollama')
const label = ref('')
const baseUrl = ref(LOCAL_RUNNER_DEFAULTS.ollama ?? '')
const apiKey = ref('')
// The models discovered by the last "Test connection", plus the user's tick selection.
const discovered = ref<string[]>([])
const selected = ref<string[]>([])
const testError = ref<string | null>(null)
const tested = ref(false)
const testing = ref(false)
const busy = ref(false)

const existing = computed(() => store.endpoints.find((e) => e.provider === provider.value))

// Switching runner type prefills the default base URL and resets the discovered models —
// editing an already-connected runner loads its stored config instead.
watch(provider, (p) => {
  const e = store.endpoints.find((x) => x.provider === p)
  if (e) {
    label.value = e.label
    baseUrl.value = e.baseUrl
    discovered.value = [...e.models]
    selected.value = [...e.models]
  } else {
    label.value = ''
    baseUrl.value = LOCAL_RUNNER_DEFAULTS[p] ?? ''
    discovered.value = []
    selected.value = []
  }
  apiKey.value = ''
  testError.value = null
  tested.value = false
})

function notifyError(title: string, e: unknown) {
  toast.add({
    title,
    description: e instanceof Error ? e.message : String(e),
    icon: 'i-lucide-triangle-alert',
    color: 'error',
  })
}

async function test() {
  if (!baseUrl.value.trim()) return
  testing.value = true
  testError.value = null
  try {
    const result = await store.test({
      provider: provider.value,
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim() || undefined,
    })
    tested.value = true
    discovered.value = result.models
    if (result.reachable) {
      // Keep any previously-enabled models that are still served, else default to all.
      const keep = selected.value.filter((m) => result.models.includes(m))
      selected.value = keep.length ? keep : [...result.models]
      testError.value = null
    } else {
      testError.value = result.error ?? t('settings.localModelEndpoints.unreachable')
    }
  } catch (e) {
    testError.value = e instanceof Error ? e.message : String(e)
  } finally {
    testing.value = false
  }
}

function toggleModel(model: string, on: boolean) {
  if (on) {
    if (!selected.value.includes(model)) selected.value = [...selected.value, model]
  } else {
    selected.value = selected.value.filter((m) => m !== model)
  }
}

async function save() {
  if (!baseUrl.value.trim() || !selected.value.length) return
  busy.value = true
  try {
    await store.upsert({
      provider: provider.value,
      label: label.value.trim() || undefined,
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim() || undefined,
      models: selected.value,
    })
    apiKey.value = ''
    toast.add({
      title: t('settings.localModelEndpoints.toast.saved', {
        name: LOCAL_RUNNER_LABELS[provider.value],
      }),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError(t('settings.localModelEndpoints.toast.saveFailed'), e)
  } finally {
    busy.value = false
  }
}

async function remove(p: LocalRunner) {
  busy.value = true
  try {
    await store.remove(p)
    if (provider.value === p) {
      baseUrl.value = LOCAL_RUNNER_DEFAULTS[p] ?? ''
      label.value = ''
      discovered.value = []
      selected.value = []
      tested.value = false
    }
    toast.add({ title: t('settings.localModelEndpoints.toast.removed'), icon: 'i-lucide-check' })
  } catch (e) {
    notifyError(t('settings.localModelEndpoints.toast.removeFailed'), e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('settings.localModelEndpoints.title')"
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #title>
      <IntegrationBackTitle :title="t('settings.localModelEndpoints.title')" @back="back" />
    </template>
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-slate-400">
          <i18n-t keypath="settings.localModelEndpoints.intro" tag="span" scope="global">
            <template #ownMachine>
              <strong>{{ t('settings.localModelEndpoints.introOwnMachine') }}</strong>
            </template>
            <template #justForYou>
              <span class="text-slate-300">{{
                t('settings.localModelEndpoints.introJustForYou')
              }}</span>
            </template>
          </i18n-t>
        </p>

        <!-- connected endpoints -->
        <div
          v-for="e in store.endpoints"
          :key="e.provider"
          class="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm"
        >
          <div>
            <span class="font-medium text-slate-200">{{ e.label }}</span>
            <span class="ml-2 text-xs text-slate-500">{{ LOCAL_RUNNER_LABELS[e.provider] }}</span>
            <div class="text-[11px] text-slate-500">
              {{ e.baseUrl }} ·
              {{
                t(
                  'settings.localModelEndpoints.modelCount',
                  { count: e.models.length },
                  e.models.length,
                )
              }}
              <template v-if="e.hasApiKey">
                · {{ t('settings.localModelEndpoints.keySet') }}</template
              >
            </div>
          </div>
          <div class="flex items-center gap-1">
            <UButton
              icon="i-lucide-pencil"
              color="neutral"
              variant="ghost"
              size="xs"
              :disabled="busy"
              :title="t('settings.localModelEndpoints.edit')"
              @click="provider = e.provider"
            />
            <UButton
              icon="i-lucide-trash-2"
              color="error"
              variant="ghost"
              size="xs"
              :disabled="busy"
              @click="remove(e.provider)"
            />
          </div>
        </div>

        <!-- add / edit form -->
        <div class="rounded-lg border border-dashed border-slate-700 p-3 space-y-3">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {{
              existing
                ? t('settings.localModelEndpoints.editRunner')
                : t('settings.localModelEndpoints.addRunner')
            }}
          </p>

          <div class="flex flex-wrap items-end gap-3">
            <UFormField :label="t('settings.localModelEndpoints.runnerType')">
              <USelect v-model="provider" :items="RUNNERS" value-key="value" class="w-48" />
            </UFormField>
            <UFormField
              :label="t('settings.localModelEndpoints.labelOptional')"
              class="flex-1 min-w-40"
            >
              <UInput
                v-model="label"
                :placeholder="
                  t('settings.localModelEndpoints.labelPlaceholder', {
                    name: LOCAL_RUNNER_LABELS[provider],
                  })
                "
              />
            </UFormField>
          </div>

          <UFormField :label="t('settings.localModelEndpoints.baseUrl')">
            <UInput v-model="baseUrl" class="font-mono" placeholder="http://localhost:11434/v1" />
          </UFormField>

          <UFormField :label="t('settings.localModelEndpoints.apiKeyOptional')">
            <UInput
              v-model="apiKey"
              type="password"
              class="font-mono"
              :placeholder="
                existing?.hasApiKey
                  ? t('settings.localModelEndpoints.apiKeyKeepPlaceholder')
                  : t('settings.localModelEndpoints.apiKeyIgnorePlaceholder')
              "
            />
          </UFormField>

          <div class="flex items-center gap-2">
            <UButton
              color="neutral"
              variant="soft"
              size="sm"
              icon="i-lucide-plug-zap"
              :loading="testing"
              :disabled="!baseUrl.trim()"
              @click="test()"
            >
              {{ t('settings.localModelEndpoints.testConnection') }}
            </UButton>
            <span v-if="testError" class="text-xs text-rose-400">{{ testError }}</span>
            <span v-else-if="tested && discovered.length" class="text-xs text-emerald-400">
              {{
                t(
                  'settings.localModelEndpoints.reachable',
                  { count: discovered.length },
                  discovered.length,
                )
              }}
            </span>
            <span v-else-if="tested" class="text-xs text-slate-500">{{
              t('settings.localModelEndpoints.noModels')
            }}</span>
          </div>

          <!-- discovered models multi-select -->
          <div v-if="discovered.length" class="space-y-1.5">
            <span class="block text-[10px] uppercase tracking-wide text-slate-500">
              {{ t('settings.localModelEndpoints.enableModels') }}
            </span>
            <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              <label
                v-for="m in discovered"
                :key="m"
                class="flex items-center gap-2 text-sm text-slate-300"
              >
                <UCheckbox
                  :model-value="selected.includes(m)"
                  @update:model-value="(v: boolean | 'indeterminate') => toggleModel(m, v === true)"
                />
                <span class="truncate font-mono text-xs">{{ m }}</span>
              </label>
            </div>
          </div>

          <div class="flex justify-end">
            <UButton
              color="primary"
              variant="soft"
              size="sm"
              icon="i-lucide-save"
              :loading="busy"
              :disabled="!baseUrl.trim() || !selected.length"
              @click="save()"
            >
              {{ existing ? t('common.save') : t('settings.localModelEndpoints.addRunner') }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
