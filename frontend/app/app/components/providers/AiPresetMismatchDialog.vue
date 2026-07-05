<script setup lang="ts">
// Shown when the workspace HAS usable AI models but its DEFAULT model preset still points
// at one or more that aren't usable under the current configuration (e.g. the built-in
// "Kimi K2.7" default with no Kimi source connected). Tasks fall back to the default
// preset, so they would dispatch onto an unavailable model and fail. This dialog names the
// offending models and offers to edit/switch the preset or configure more vendors. It
// auto-opens once per session (driven from pages/index.vue) and clears once the preset is
// fixed (or all its models become available).
import { computed } from 'vue'

const { t } = useI18n()
const ui = useUiStore()
const models = useModelsStore()
const modelPresets = useModelPresetsStore()
const { defaultPresetUnavailable } = useAiReadiness()

const open = computed({
  get: () => ui.aiPresetMismatchOpen,
  set: (v: boolean) => (v ? ui.openAiPresetMismatch() : ui.closeAiPresetMismatch()),
})

const presetName = computed(
  () => modelPresets.defaultPreset?.name ?? t('providers.presetMismatch.defaultPresetName'),
)

/** Readable labels for the unavailable model ids (catalog label, else the raw id). */
const unavailableLabels = computed(() =>
  defaultPresetUnavailable.value.map((id) => models.labelForId(id)),
)

function go(action: () => void) {
  ui.closeAiPresetMismatch()
  action()
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('providers.presetMismatch.title')"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <div class="space-y-5">
        <i18n-t
          keypath="providers.presetMismatch.intro"
          tag="p"
          class="text-sm text-slate-300"
          scope="global"
        >
          <template #name>
            <span class="font-medium text-slate-100">{{ presetName }}</span>
          </template>
        </i18n-t>

        <div class="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {{ t('providers.presetMismatch.unavailable') }}
          </p>
          <div class="flex flex-wrap gap-1.5">
            <UBadge
              v-for="label in unavailableLabels"
              :key="label"
              color="warning"
              variant="subtle"
              size="sm"
            >
              {{ label }}
            </UBadge>
          </div>
        </div>

        <p class="text-[13px] text-slate-400">
          {{ t('providers.presetMismatch.advice') }}
        </p>

        <div class="flex flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            @click="
              () => {
                open = false
              }
            "
          >
            {{ t('providers.presetMismatch.later') }}
          </UButton>
          <UButton
            color="neutral"
            variant="subtle"
            size="sm"
            icon="i-lucide-key-round"
            @click="go(ui.openVendorCredentials)"
          >
            {{ t('providers.presetMismatch.configureVendors') }}
          </UButton>
          <UButton color="primary" size="sm" icon="i-lucide-cpu" @click="go(ui.openModelConfig)">
            {{ t('providers.presetMismatch.editPresets') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
