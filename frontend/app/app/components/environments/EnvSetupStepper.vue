<script setup lang="ts">
// The environment-setup wizard's stepper header, driven entirely by
// `useJourneyProgress` (modular-react#83, production-feedback item 4). The ordered
// steps, the live position, and the "Step X of N" total all come from
// `resolveStepSequence` walking the journey's transition graph — there is no
// hand-maintained step-order array to keep in sync (the old `ENV_STEP_ORDER` +
// `crumbState` is gone). Rendered inside `<JourneyHost>`, which hands it the live
// `instanceId`; each step's label is the i18n key carried in the journey's `steps`
// metadata.
import type { InstanceId } from '@modular-vue/journeys'
import { useJourneyProgress } from '@modular-vue/journeys'
import { environmentSetupJourney } from '~/modular/journeys/environmentSetup'
import type { EnvSetupInput } from '~/modular/journeys/environmentSetup.logic'

const props = defineProps<{
  /** The live journey instance from `<JourneyHost>`, or null before it starts. */
  instanceId: InstanceId | null
  /** The launch input; frozen for the host's lifetime, so the resolved spine is
   *  stable (`useJourneyProgress` reads `sequence.input` once at setup). */
  input: EnvSetupInput
}>()

const { t, te } = useI18n()

const { index, total, steps } = useJourneyProgress(
  () => props.instanceId,
  environmentSetupJourney,
  { sequence: { input: props.input } },
)

/** Resolve a step's progress-label key (from the journey's `steps` metadata)
 *  through i18n, tolerating a locale that omits it rather than leaking the key. */
function stepLabel(key: string | undefined): string {
  return key && te(key) ? t(key) : ''
}
</script>

<template>
  <div class="space-y-2" data-testid="env-setup-stepper">
    <p v-if="total" class="text-[11px] font-medium text-slate-400" data-testid="env-setup-progress">
      {{ t('environmentWizard.progress', { index: index + 1, total }) }}
    </p>
    <ol class="flex items-center gap-2 text-[11px]">
      <li
        v-for="(step, i) in steps"
        :key="step.entry"
        class="flex items-center gap-2"
        :data-testid="`env-setup-crumb-${step.entry}`"
      >
        <span
          class="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold"
          :class="{
            'bg-primary-500 text-white': i === index,
            'bg-emerald-600/70 text-white': i < index,
            'bg-slate-700 text-slate-300': i > index,
          }"
          >{{ i + 1 }}</span
        >
        <span :class="i === index ? 'text-slate-100' : 'text-slate-500'">
          {{ stepLabel(step.progressLabel) }}
        </span>
        <UIcon
          v-if="i < steps.length - 1"
          name="i-lucide-chevron-right"
          class="h-3 w-3 text-slate-600"
        />
      </li>
    </ol>
  </div>
</template>
