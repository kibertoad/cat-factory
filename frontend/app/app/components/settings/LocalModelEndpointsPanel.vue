<script setup lang="ts">
// Per-user settings: "My local runners" — the signed-in user's own-machine LLM endpoints
// (Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible server). A runner lives on
// a person's box, so these are stored per-user (not pooled). Pick a runner type (prefills the
// default base URL), optionally a bearer key, then "Test connection" to discover the models it
// serves and tick which to enable. Save persists the endpoint; the enabled models then surface
// automatically in the per-workspace model picker. One endpoint per runner type.
import { computed, ref, watch } from 'vue'
import { LOCAL_RUNNER_DEFAULTS, LOCAL_RUNNER_LABELS, type LocalRunner } from '~/types/localModels'

const ui = useUiStore()
const store = useLocalModelsStore()
const toast = useToast()

const open = computed({
  get: () => ui.localModelsOpen,
  set: (v: boolean) => (v ? ui.openLocalModels() : ui.closeLocalModels()),
})

// Load the user's endpoints whenever the panel opens (loaded independently of the
// workspace snapshot, like personal subscriptions).
watch(open, (isOpen) => {
  if (isOpen) void store.load()
})

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
      testError.value = result.error ?? 'Could not reach the runner.'
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
      title: `${LOCAL_RUNNER_LABELS[provider.value]} saved`,
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    notifyError('Could not save runner', e)
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
    toast.add({ title: 'Runner removed', icon: 'i-lucide-check' })
  } catch (e) {
    notifyError('Could not remove runner', e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="My local runners" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-slate-400">
          Point agents at an LLM running on <strong>your own machine</strong> — Ollama, LM Studio,
          llama.cpp, vLLM, or any OpenAI-compatible server. A runner is stored
          <span class="text-slate-300">just for you</span> (a runner lives on your box), and the
          models you enable appear automatically in the model picker. The API key (most runners
          ignore it) is write-only and never shown again.
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
              {{ e.baseUrl }} · {{ e.models.length }} model{{ e.models.length === 1 ? '' : 's' }}
              <template v-if="e.hasApiKey"> · key set</template>
            </div>
          </div>
          <div class="flex items-center gap-1">
            <UButton
              icon="i-lucide-pencil"
              color="neutral"
              variant="ghost"
              size="xs"
              :disabled="busy"
              title="Edit"
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
            {{ existing ? 'Edit runner' : 'Add a runner' }}
          </p>

          <div class="flex flex-wrap items-end gap-3">
            <UFormField label="Runner type">
              <USelect v-model="provider" :items="RUNNERS" value-key="value" class="w-48" />
            </UFormField>
            <UFormField label="Label (optional)" class="flex-1 min-w-40">
              <UInput v-model="label" :placeholder="`My ${LOCAL_RUNNER_LABELS[provider]}`" />
            </UFormField>
          </div>

          <UFormField label="Base URL">
            <UInput v-model="baseUrl" class="font-mono" placeholder="http://localhost:11434/v1" />
          </UFormField>

          <UFormField label="API key (optional)">
            <UInput
              v-model="apiKey"
              type="password"
              class="font-mono"
              :placeholder="
                existing?.hasApiKey ? 'leave blank to keep stored key' : 'most runners ignore this'
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
              Test connection
            </UButton>
            <span v-if="testError" class="text-xs text-rose-400">{{ testError }}</span>
            <span v-else-if="tested && discovered.length" class="text-xs text-emerald-400">
              Reachable · {{ discovered.length }} model{{ discovered.length === 1 ? '' : 's' }}
            </span>
            <span v-else-if="tested" class="text-xs text-slate-500">No models reported.</span>
          </div>

          <!-- discovered models multi-select -->
          <div v-if="discovered.length" class="space-y-1.5">
            <span class="block text-[10px] uppercase tracking-wide text-slate-500">
              Enable models
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
              {{ existing ? 'Save' : 'Add runner' }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
