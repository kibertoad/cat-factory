<script setup lang="ts">
// The environment setup wizard shell (shared-stacks slice 7; converted to a
// modular-vue journey in slice 3 of the modular-vue adoption —
// docs/initiatives/modular-vue-adoption.md).
//
// This component is now purely the MODAL + STEPPER CHROME. The step sequence,
// forward/back navigation, and resume are owned by the `environment-setup`
// journey (`~/modular/journeys/environmentSetup`), hosted here by `<JourneyHost>`:
// it starts the journey on open (RESUMING the in-flight instance for the same
// frame when one was left mid-flow, via the Pinia persistence adapter), renders
// the current step through `<JourneyOutlet>`, and abandons it on close. Each step
// component drives the `environmentWizard` store for its data/actions and fires
// the journey's exits to advance. On `complete` (the save step's Done) the journey
// clears its persisted blob and we close the modal.
import { computed } from 'vue'
import { JourneyHost, JourneyOutlet } from '@modular-vue/journeys'
import { environmentSetupHandle } from '~/modular/journeys/environmentSetup'
import { ENV_STEP_ORDER, type EnvStep } from '~/modular/journeys/environmentSetup.logic'

const ui = useUiStore()
const { t } = useI18n()

const open = computed({
  get: () => ui.environmentWizardOpen,
  set: (v: boolean) => {
    if (!v) ui.closeEnvironmentSetup()
  },
})

// Read once at journey start; keyed for resume. Frozen for the host's lifetime,
// so the modal remounts the host per open (it renders under `v-if` upstream).
const input = computed(() => ({ frameId: ui.environmentWizardFrameId }))

const STEP_LABEL = computed<Record<EnvStep, string>>(() => ({
  pick: t('environmentWizard.steps.pick'),
  review: t('environmentWizard.steps.review'),
  preflight: t('environmentWizard.steps.preflight'),
  save: t('environmentWizard.steps.save'),
}))

/** The crumb index of a step, relative to the current journey step. */
function crumbState(
  entry: EnvStep,
  currentEntry: EnvStep | undefined,
): 'current' | 'done' | 'todo' {
  if (!currentEntry) return 'todo'
  if (entry === currentEntry) return 'current'
  return ENV_STEP_ORDER.indexOf(entry) < ENV_STEP_ORDER.indexOf(currentEntry) ? 'done' : 'todo'
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('environmentWizard.title')"
    :description="t('environmentWizard.subtitle')"
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <div class="space-y-5" data-testid="env-setup-wizard">
        <JourneyHost
          :handle="environmentSetupHandle"
          :input="input"
          @finished="ui.closeEnvironmentSetup()"
        >
          <template #default="{ instanceId, instance }">
            <!-- stepper header, driven by the journey's current step -->
            <ol class="flex items-center gap-2 text-[11px]">
              <li
                v-for="(s, i) in ENV_STEP_ORDER"
                :key="s"
                class="flex items-center gap-2"
                :data-testid="`env-setup-crumb-${s}`"
              >
                <span
                  class="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold"
                  :class="{
                    'bg-primary-500 text-white':
                      crumbState(s, (instance?.step?.entry as EnvStep) ?? undefined) === 'current',
                    'bg-emerald-600/70 text-white':
                      crumbState(s, (instance?.step?.entry as EnvStep) ?? undefined) === 'done',
                    'bg-slate-700 text-slate-300':
                      crumbState(s, (instance?.step?.entry as EnvStep) ?? undefined) === 'todo',
                  }"
                  >{{ i + 1 }}</span
                >
                <span
                  :class="
                    crumbState(s, (instance?.step?.entry as EnvStep) ?? undefined) === 'current'
                      ? 'text-slate-100'
                      : 'text-slate-500'
                  "
                >
                  {{ STEP_LABEL[s] }}
                </span>
                <UIcon
                  v-if="i < ENV_STEP_ORDER.length - 1"
                  name="i-lucide-chevron-right"
                  class="h-3 w-3 text-slate-600"
                />
              </li>
            </ol>

            <!-- the current step (pick / review / preflight / save) -->
            <div class="mt-4">
              <JourneyOutlet :instance-id="instanceId" />
            </div>
          </template>
        </JourneyHost>
      </div>
    </template>
  </UModal>
</template>
