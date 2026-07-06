<script setup lang="ts">
// Create a new INITIATIVE under a service frame — the longer-running counterpart to a task. The
// user picks a PRESET (the built-in "Custom initiative" plus any a deployment registered), fills
// the preset's descriptor-driven form, and names the goal; the server materialises the
// initiative-level board block + its empty tracker entity in one call, freezing the (validated,
// sanitized) preset inputs on the entity. Nothing is planned here: the user then runs the preset's
// planning pipeline on the block from the inspector.
//
// The preset form is rendered GENERICALLY from `descriptor.fields` (InitiativePresetFields) — zero
// per-preset frontend code. A preset with a repo-detection probe prefills its form from the frame's
// repo on selection (best-effort; failures fall back to descriptor defaults and never block create).
import { computed, ref, watch } from 'vue'
import {
  sanitizeInitiativePresetInputs,
  validateInitiativePresetInputs,
} from '@cat-factory/contracts'
import type { InitiativePresetInputs, InitiativePresetInputValue } from '~/types/domain'
import { defaultPresetInputs } from '~/utils/initiative'
import { GENERIC_PRESET_ID } from '~/stores/initiative'
import InitiativePresetFields from '~/components/board/InitiativePresetFields.vue'

const ui = useUiStore()
const board = useBoardStore()
const initiatives = useInitiativesStore()
const toast = useToast()
const { t } = useI18n()

const open = computed({
  get: () => ui.createInitiativeFrameId !== null,
  set: (v: boolean) => {
    if (!v) ui.closeCreateInitiative()
  },
})

const frame = computed(() =>
  ui.createInitiativeFrameId ? board.getBlock(ui.createInitiativeFrameId) : undefined,
)

const presets = computed(() => initiatives.presets)
const selectedPresetId = ref(GENERIC_PRESET_ID)
// The resolved descriptor (defaulting to the generic preset). Null only when presets haven't
// hydrated yet — the create call still sends `preset_generic`, which the server always resolves.
const selectedPreset = computed(() => initiatives.presetById(selectedPresetId.value))

const title = ref('')
const description = ref('')
const inputs = ref<InitiativePresetInputs>({})

// Monotonic token so a slow probe response from a since-changed preset/frame is discarded.
let probeSeq = 0

/** Seed the form to the selected preset's descriptor defaults, then fire its detection probe. */
function applyPreset(): void {
  const descriptor = selectedPreset.value
  inputs.value = descriptor ? defaultPresetInputs(descriptor) : {}
  void runProbe()
}

/** Whether two preset values are equal (shallow — arrays compared element-wise). */
function sameValue(
  a: InitiativePresetInputValue | undefined,
  b: InitiativePresetInputValue | undefined,
): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => x === b[i])
  return a === b
}

/** Best-effort repo-detection prefill: merge detected values (known fields only) over the defaults. */
async function runProbe(): Promise<void> {
  const descriptor = selectedPreset.value
  const frameId = ui.createInitiativeFrameId
  if (!descriptor?.probe || !frameId) return
  const seq = ++probeSeq
  // The just-seeded descriptor defaults; a detected value overrides these but NOT a user edit.
  const baseline = inputs.value
  const detected = await initiatives.probePreset(descriptor.id, frameId)
  // Discard a stale response (the user re-picked a preset / closed the modal meanwhile).
  if (seq !== probeSeq || selectedPreset.value?.id !== descriptor.id) return
  const known = new Set(descriptor.fields.map((f) => f.key))
  const merged: InitiativePresetInputs = { ...inputs.value }
  for (const [key, value] of Object.entries(detected)) {
    // Prefill only known fields the user hasn't edited since the probe fired (still at the default),
    // so a slow probe can't clobber a value the user typed while it was in flight.
    if (known.has(key) && sameValue(merged[key], baseline[key])) merged[key] = value
  }
  inputs.value = merged
}

function selectPreset(id: string): void {
  if (id === selectedPresetId.value) return
  selectedPresetId.value = id
  applyPreset()
}

watch(open, (o) => {
  if (!o) return
  title.value = ''
  description.value = ''
  selectedPresetId.value = GENERIC_PRESET_ID
  applyPreset()
})

// Client-side mirror of the server's create validation (the SAME shared function), so the submit
// button reflects an invalid form; the per-field path error is shown inline by the renderer.
const presetProblems = computed(() =>
  selectedPreset.value ? validateInitiativePresetInputs(selectedPreset.value, inputs.value) : [],
)
const canSubmit = computed(
  () => title.value.trim().length > 0 && presetProblems.value.length === 0 && !initiatives.creating,
)

async function create() {
  const frameId = ui.createInitiativeFrameId
  if (!frameId || !canSubmit.value) return
  const descriptor = selectedPreset.value
  try {
    const { block } = await initiatives.create(frameId, {
      title: title.value.trim(),
      description: description.value.trim() || undefined,
      presetId: descriptor?.id ?? GENERIC_PRESET_ID,
      presetInputs: descriptor
        ? sanitizeInitiativePresetInputs(descriptor, inputs.value)
        : undefined,
    })
    ui.closeCreateInitiative()
    // Select the fresh block so the inspector offers "Run planning" right away.
    ui.select(block.id)
  } catch (e) {
    toast.add({
      title: t('initiative.create.failedTitle'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('initiative.create.title')">
    <template #body>
      <div class="space-y-4" data-testid="create-initiative-modal">
        <p v-if="frame" class="text-xs text-slate-400">
          <i18n-t keypath="initiative.create.inFrame" tag="span" scope="global">
            <template #frame>
              <span class="font-medium text-slate-200">{{ frame.title }}</span>
            </template>
          </i18n-t>
        </p>

        <!-- Preset picker: only when a deployment registered presets beyond the built-in generic
             one, so a single-preset install keeps today's plain form. -->
        <div v-if="presets.length > 1" class="space-y-1.5">
          <span class="text-xs font-medium text-slate-300">{{
            t('initiative.create.preset')
          }}</span>
          <div class="grid gap-2" data-testid="initiative-preset-picker">
            <button
              v-for="p in presets"
              :key="p.id"
              type="button"
              :data-testid="`initiative-preset-option-${p.id}`"
              :aria-pressed="p.id === selectedPresetId"
              class="flex items-start gap-3 rounded-md border px-3 py-2 text-left transition"
              :class="
                p.id === selectedPresetId
                  ? 'border-primary-500 bg-primary-950/30'
                  : 'border-slate-700 hover:border-slate-600'
              "
              @click="selectPreset(p.id)"
            >
              <UIcon
                :name="p.presentation.icon"
                class="mt-0.5 size-5 shrink-0"
                :style="{ color: p.presentation.color }"
              />
              <span class="min-w-0">
                <span class="block text-sm font-medium text-slate-200">
                  {{ p.presentation.label }}
                </span>
                <span class="block text-[11px] text-slate-400">
                  {{ p.presentation.description }}
                </span>
              </span>
            </button>
          </div>
        </div>

        <UFormField :label="t('initiative.create.titleField')" required>
          <UInput
            v-model="title"
            data-testid="create-initiative-title"
            :placeholder="t('initiative.create.titlePlaceholder')"
            autofocus
            class="w-full"
            @keydown.enter="create"
          />
        </UFormField>

        <UFormField :label="t('initiative.create.goalField')">
          <UTextarea
            v-model="description"
            data-testid="create-initiative-goal"
            :rows="4"
            autoresize
            :placeholder="t('initiative.create.goalPlaceholder')"
            class="w-full"
          />
        </UFormField>

        <!-- The preset's descriptor-driven form (renders nothing for the fieldless generic preset). -->
        <InitiativePresetFields
          v-if="selectedPreset"
          v-model="inputs"
          :descriptor="selectedPreset"
        />

        <p class="text-[11px] text-slate-500">
          {{ t('initiative.create.hint') }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          @click="
            () => {
              open = false
            }
          "
        >
          {{ t('common.cancel') }}
        </UButton>
        <UButton
          data-testid="create-initiative-submit"
          color="primary"
          :loading="initiatives.creating"
          :disabled="!canSubmit"
          @click="create"
        >
          {{ t('initiative.create.submit') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
