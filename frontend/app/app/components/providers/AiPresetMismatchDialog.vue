<script setup lang="ts">
// Shown when the workspace HAS usable AI models but its DEFAULT model preset still points
// at one or more that aren't usable under the current configuration (e.g. the built-in
// "Kimi K2.7" default with no Kimi source connected). Tasks fall back to the default
// preset, so they would dispatch onto an unavailable model and fail. This dialog names the
// offending models and offers to edit/switch the preset or configure more vendors. It
// auto-opens once per session (driven from pages/index.vue) and clears once the preset is
// fixed (or all its models become available).
import { computed } from 'vue'

const ui = useUiStore()
const models = useModelsStore()
const modelPresets = useModelPresetsStore()
const { defaultPresetUnavailable } = useAiReadiness()

const open = computed({
  get: () => ui.aiPresetMismatchOpen,
  set: (v: boolean) => (v ? ui.openAiPresetMismatch() : ui.closeAiPresetMismatch()),
})

const presetName = computed(() => modelPresets.defaultPreset?.name ?? 'default preset')

/** Readable labels for the unavailable model ids (catalog label, else the raw id). */
const unavailableLabels = computed(() =>
  defaultPresetUnavailable.value.map((id) => models.getModel(id)?.label ?? id),
)

function go(action: () => void) {
  ui.closeAiPresetMismatch()
  action()
}
</script>

<template>
  <UModal v-model:open="open" title="Preset uses unavailable models" :ui="{ content: 'max-w-xl' }">
    <template #body>
      <div class="space-y-5">
        <p class="text-sm text-slate-300">
          The workspace default model preset
          <span class="font-medium text-slate-100">“{{ presetName }}”</span>
          assigns models that aren't available under the current configuration. Tasks that use this
          preset would fail when they reach those steps.
        </p>

        <div class="rounded-lg border border-slate-700 bg-slate-900/50 p-3">
          <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Unavailable
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
          Either repoint the preset at models you have configured, or add the missing provider.
        </p>

        <div class="flex flex-wrap justify-end gap-2">
          <UButton color="neutral" variant="ghost" size="sm" @click="open = false"> Later </UButton>
          <UButton
            color="neutral"
            variant="subtle"
            size="sm"
            icon="i-lucide-key-round"
            @click="go(ui.openVendorCredentials)"
          >
            Configure vendors
          </UButton>
          <UButton color="primary" size="sm" icon="i-lucide-cpu" @click="go(ui.openModelConfig)">
            Edit presets
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
