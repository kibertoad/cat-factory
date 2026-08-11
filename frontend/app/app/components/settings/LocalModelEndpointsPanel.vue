<script setup lang="ts">
// Per-user settings: "My local runners" — the signed-in user's own-machine LLM endpoints
// (Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible server). A runner lives on
// a person's box, so these are stored per-user (not pooled). Pick a runner type (prefills the
// default base URL), optionally a bearer key, then "Test connection" to discover the models it
// serves and tick which to enable. Save persists the endpoint; the enabled models then surface
// automatically in the per-workspace model picker. One endpoint per runner type.
import { computed, ref, watch } from 'vue'

import {
  knownLocalModel,
  LOCAL_RUNNER_DEFAULTS,
  LOCAL_RUNNER_LABELS,
  type LocalModelDeclaration,
  type LocalRunner,
  type LocalRunnerUrlReason,
} from '~/types/localModels'
import IntegrationBackTitle from '~/components/layout/IntegrationBackTitle.vue'
import SecretInput from '~/components/common/SecretInput.vue'

const { t } = useI18n()
const ui = useUiStore()
const store = useLocalModelsStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { confirm } = useConfirm()

const open = computed({
  get: () => ui.localModelsOpen,
  set: (v: boolean) => (v ? ui.openLocalModels() : ui.closeLocalModels()),
})
const back = useIntegrationBack(open)

const RUNNERS: { value: LocalRunner; label: string }[] = (
  Object.keys(LOCAL_RUNNER_LABELS) as LocalRunner[]
).map((value) => ({ value, label: LOCAL_RUNNER_LABELS[value] }))

// Why the deployment refuses a runner URL, in translated copy. An exhaustive Record keyed
// off the contracts union, so adding a reason backend-side fails this typecheck instead of
// rendering the backend's English (which stays available as the "details" line).
const URL_REASON_KEYS = {
  invalid_url: 'settings.localModelEndpoints.urlReason.invalid_url',
  scheme_not_allowed: 'settings.localModelEndpoints.urlReason.scheme_not_allowed',
  credentials_not_allowed: 'settings.localModelEndpoints.urlReason.credentials_not_allowed',
  query_or_fragment_not_allowed:
    'settings.localModelEndpoints.urlReason.query_or_fragment_not_allowed',
  host_not_loopback: 'settings.localModelEndpoints.urlReason.host_not_loopback',
  host_not_local: 'settings.localModelEndpoints.urlReason.host_not_local',
} as const satisfies Record<LocalRunnerUrlReason, string>

function urlReasonText(reason: LocalRunnerUrlReason): string {
  return t(URL_REASON_KEYS[reason])
}

// Whether an enabled model reads IMAGES. Three states, because the runner's `/models` probe cannot
// tell us and "nobody has said" is not the same answer as "no": undeclared says the platform never
// asked, while `no` says the model cannot. Mirrors `LocalModelDeclaration.acceptsImages`.
//
// For a RECOGNISED family the platform already knows, so leaving this alone is the right answer and
// the "not set" option says which way that falls: the control is the ESCAPE HATCH for a build the
// table cannot know about (a text-only quant, a fine-tune, a re-tagged copy), not a step everyone
// has to take.
const IMAGE_INPUT_CHOICES = ['unknown', 'yes', 'no'] as const
type ImageInputChoice = (typeof IMAGE_INPUT_CHOICES)[number]

function choiceFor(declared: LocalModelDeclaration): ImageInputChoice {
  return declared.acceptsImages === undefined ? 'unknown' : declared.acceptsImages ? 'yes' : 'no'
}

/** The declared modality for a choice, as a spread-ready slice (undeclared adds no key at all). */
function modalityOf(choice: ImageInputChoice | undefined): { acceptsImages?: boolean } {
  if (choice === 'yes') return { acceptsImages: true }
  if (choice === 'no') return { acceptsImages: false }
  return {}
}

/**
 * What "not set" will actually do for one model id: name the recognised family and the modality it
 * implies, else say plainly that nothing has been said. Read from the SAME table the engine folds
 * onto the dispatched ref, so this label cannot promise a picture the run then withholds.
 */
function unsetLabelFor(modelId: string): string {
  const known = knownLocalModel(modelId)
  if (!known) return t('settings.localModelEndpoints.imageInput.unknown')
  return t(
    known.acceptsImages
      ? 'settings.localModelEndpoints.imageInput.autoYes'
      : 'settings.localModelEndpoints.imageInput.autoNo',
    { family: known.label },
  )
}

// ---- add / edit draft ------------------------------------------------------
const provider = ref<LocalRunner>('ollama')
const label = ref('')
const baseUrl = ref(LOCAL_RUNNER_DEFAULTS.ollama ?? '')
const apiKey = ref('')
// The models discovered by the last "Test connection", plus the user's tick selection and what
// they declared about each ticked one (kept per model id, so un-ticking and re-ticking a model
// does not silently drop the declaration they already made for it).
const discovered = ref<string[]>([])
const selected = ref<string[]>([])
const imageInput = ref<Record<string, ImageInputChoice>>({})

/**
 * The three options per discovered model: "not set" carries what the recognised-family table will
 * do. Built once per discovered set rather than per row per render, because the "not set" label
 * scans the family table and a fresh array identity each tick also defeats the select's own
 * memoisation (a runner serving forty models re-ran both on every keystroke elsewhere in the form).
 */
const imageInputItems = computed<Record<string, { value: ImageInputChoice; label: string }[]>>(() =>
  Object.fromEntries(
    discovered.value.map((modelId) => [
      modelId,
      IMAGE_INPUT_CHOICES.map((value) => ({
        value,
        label:
          value === 'unknown'
            ? unsetLabelFor(modelId)
            : t(`settings.localModelEndpoints.imageInput.${value}`),
      })),
    ]),
  ),
)
const testError = ref<string | null>(null)
// The backend's own wording, kept as DETAIL beside a translated refusal rather than being
// shown as the description (it names env vars an operator, not this user, acts on).
const testErrorDetail = ref<string | null>(null)
const tested = ref(false)
const testing = ref(false)
const busy = ref(false)

const existing = computed(() => store.endpoints.find((e) => e.provider === provider.value))

/**
 * Point the draft at one runner: its stored config when that runner is already connected (so the
 * ticks and the declarations the user made come back), else the defaults for a fresh one.
 *
 * Called EXPLICITLY from each event that means "start editing this runner", never watched off
 * `provider`, because the commonest of those events does not change it: clicking Edit on the row
 * the form is already showing assigns the same value, which fires no watcher. The draft would then
 * be whatever the empty initial state was, and saving it PUTs every model with no declaration,
 * destroying what the user had recorded with nothing saying so.
 */
function seedDraft(p: LocalRunner) {
  const e = store.endpoints.find((x) => x.provider === p)
  label.value = e?.label ?? ''
  baseUrl.value = e?.baseUrl ?? LOCAL_RUNNER_DEFAULTS[p] ?? ''
  discovered.value = e?.models.map((m) => m.id) ?? []
  selected.value = e?.models.map((m) => m.id) ?? []
  imageInput.value = Object.fromEntries(e?.models.map((m) => [m.id, choiceFor(m)]) ?? [])
  apiKey.value = ''
  testError.value = null
  testErrorDetail.value = null
  tested.value = false
}

/** Select a runner in the form: the runner-type select and each row's Edit button share this. */
function selectRunner(p: LocalRunner) {
  provider.value = p
  seedDraft(p)
}

// Load the user's endpoints whenever the panel opens (loaded independently of the workspace
// snapshot, like personal subscriptions), then seed the draft from what arrived. The seed WAITS
// for the load: the panel mounts against an empty store, so seeding before it resolves would
// leave a form headed "Edit runner" holding none of that runner's config.
watch(
  open,
  async (isOpen) => {
    if (!isOpen) return
    await store.load()
    seedDraft(provider.value)
  },
  { immediate: true },
)

async function test() {
  if (!baseUrl.value.trim()) return
  testing.value = true
  testError.value = null
  testErrorDetail.value = null
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
      // A policy refusal describes itself in the user's language; the backend's English
      // stays as the detail line. A genuine reachability failure has no reason vocabulary.
      testError.value = result.errorReason
        ? urlReasonText(result.errorReason)
        : (result.error ?? t('settings.localModelEndpoints.unreachable'))
      testErrorDetail.value = result.errorReason ? (result.error ?? null) : null
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
      models: selected.value.map((id) => ({ id, ...modalityOf(imageInput.value[id]) })),
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
    present(e, 'settings.localModelEndpoints.toast.saveFailed')
  } finally {
    busy.value = false
  }
}

async function remove(p: LocalRunner) {
  const ok = await confirm({
    title: t('settings.localModelEndpoints.confirmRemove.title'),
    description: t('settings.localModelEndpoints.confirmRemove.body', {
      name: LOCAL_RUNNER_LABELS[p],
    }),
    variant: 'destructive',
    confirmLabel: t('common.remove'),
    icon: 'i-lucide-trash-2',
  })
  if (!ok) return
  busy.value = true
  try {
    await store.remove(p)
    // The row is gone from the store, so re-seeding the draft it was showing yields the
    // fresh-runner defaults: the same reset, without a second copy of what a reset means.
    if (provider.value === p) seedDraft(p)
    toast.add({ title: t('settings.localModelEndpoints.toast.removed'), icon: 'i-lucide-check' })
  } catch (e) {
    present(e, 'settings.localModelEndpoints.toast.removeFailed')
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
            <span class="ms-2 text-xs text-slate-500">{{ LOCAL_RUNNER_LABELS[e.provider] }}</span>
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
            <!-- A row whose URL the deployment no longer permits: its models are withheld
                 from the picker, so this is the only place that can say why. -->
            <div v-if="e.urlBlockedReason" class="mt-1 text-[11px] text-amber-400">
              {{ t('settings.localModelEndpoints.blocked') }}
              <span class="block text-amber-300/70">{{ urlReasonText(e.urlBlockedReason) }}</span>
            </div>
            <!-- Part of the stored model list could not be read and was discarded. Without this
                 the shortened list reads exactly like a runner nothing was ever enabled on, and
                 only one of those is fixed by re-ticking. -->
            <div v-if="e.unreadableModels" class="mt-1 text-[11px] text-amber-400">
              {{ t('settings.localModelEndpoints.modelsDiscarded') }}
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
              @click="selectRunner(e.provider)"
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
              <USelect
                :model-value="provider"
                :items="RUNNERS"
                value-key="value"
                class="w-48"
                @update:model-value="(v: string) => selectRunner(v as LocalRunner)"
              />
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
            <SecretInput
              v-model="apiKey"
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
            <span v-if="testError" class="text-xs text-rose-400">
              {{ testError }}
              <span v-if="testErrorDetail" class="block text-[11px] text-rose-300/70">{{
                testErrorDetail
              }}</span>
            </span>
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

          <!-- discovered models multi-select, each with its declared image support -->
          <div v-if="discovered.length" class="space-y-1.5">
            <span class="block text-[10px] uppercase tracking-wide text-slate-500">
              {{ t('settings.localModelEndpoints.enableModels') }}
            </span>
            <p class="text-[11px] text-slate-500">
              {{ t('settings.localModelEndpoints.imageInputHint') }}
            </p>
            <div class="space-y-1.5">
              <div v-for="m in discovered" :key="m" class="flex items-center gap-2">
                <label class="flex min-w-0 flex-1 items-center gap-2 text-sm text-slate-300">
                  <UCheckbox
                    :model-value="selected.includes(m)"
                    @update:model-value="
                      (v: boolean | 'indeterminate') => toggleModel(m, v === true)
                    "
                  />
                  <span class="truncate font-mono text-xs">{{ m }}</span>
                </label>
                <!-- Shown only for a model that is actually enabled: declaring a modality for one
                     nothing can run would be a setting with no effect. -->
                <USelect
                  v-if="selected.includes(m)"
                  :model-value="imageInput[m] ?? 'unknown'"
                  :items="imageInputItems[m]"
                  value-key="value"
                  size="xs"
                  class="w-52 shrink-0"
                  :aria-label="t('settings.localModelEndpoints.imageInputLabel', { model: m })"
                  @update:model-value="(v: string) => (imageInput[m] = v as ImageInputChoice)"
                />
              </div>
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
