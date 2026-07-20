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
// the current step through `<JourneyOutlet>`, and abandons it on close. The
// stepper header + "Step X of N" are derived from the journey's transition graph
// by `<EnvSetupStepper>` (via `useJourneyProgress`), not a hand-maintained step
// list. Each step component drives the `environmentWizard` store for its
// data/actions and fires the journey's exits to advance. On `complete` (the save
// step's Done) the journey clears its persisted blob and we close the modal.
import { computed } from 'vue'
import { JourneyHost, JourneyOutlet } from '@modular-vue/journeys'
import { environmentSetupHandle } from '~/modular/journeys/environmentSetup'

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
          <template #default="{ instanceId }">
            <!-- stepper header, derived from the journey graph -->
            <EnvSetupStepper :instance-id="instanceId" :input="input" />

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
