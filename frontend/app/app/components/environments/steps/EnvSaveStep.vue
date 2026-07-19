<script setup lang="ts">
// The environment-setup journey's SAVE step (slice 3 of the modular-vue adoption).
// Persists the confirmed recipe onto the frame + registers the workspace's
// docker-compose handler, then optionally trial-provisions with live logs.
// "Done" fires the journey's `advance` exit, which the transition maps to `complete`
// — the host closes the modal on finish.
import ProvisioningLogsDrawer from '~/components/provisioning/ProvisioningLogsDrawer.vue'
import JourneyStepNav from '~/components/environments/steps/JourneyStepNav.vue'
import { useEnvironmentWizardTarget } from '~/modular/journeys/environmentSetup.frame'

const props = defineProps<{
  input: { frameId: string | null }
  exit: (name: 'advance') => void
  goBack?: () => void
}>()

const store = useEnvironmentWizardStore()
const { t } = useI18n()

// Keep the data store pointed at THIS step's frame, so `save()` persists the
// frame the journey is actually on (not a stale one). Idempotent; see composable.
useEnvironmentWizardTarget(() => props.input.frameId)
</script>

<template>
  <section class="space-y-3" data-testid="env-setup-step-save">
    <UFormField
      :label="t('environmentWizard.save.handlerLabel')"
      :description="t('environmentWizard.save.handlerHint')"
    >
      <UInput v-model="store.handlerLabel" class="w-full" data-testid="env-setup-handler-label" />
    </UFormField>

    <div class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-[12px] text-slate-300">
      <p>
        {{
          t('environmentWizard.save.summary', {
            frame: store.targetFrame?.title ?? '',
            service: store.composeService,
          })
        }}
      </p>
    </div>

    <p
      v-if="store.saveError"
      class="text-[12px] text-rose-300/80"
      data-testid="env-setup-save-error"
    >
      {{ store.saveError }}
    </p>

    <div v-if="!store.saved" class="flex justify-end">
      <UButton
        color="primary"
        icon="i-lucide-save"
        :loading="store.saving"
        :disabled="!store.composeService.trim()"
        data-testid="env-setup-save"
        @click="store.save()"
      >
        {{ t('environmentWizard.save.save') }}
      </UButton>
    </div>

    <!-- saved: confirmation + optional trial provision -->
    <template v-else>
      <div
        class="flex items-center gap-2 rounded-md border border-emerald-800/50 bg-emerald-950/30 p-2 text-[12px] text-emerald-200"
        data-testid="env-setup-saved"
      >
        <UIcon name="i-lucide-check-circle" class="h-4 w-4" />
        {{ t('environmentWizard.save.saved') }}
      </div>

      <div class="flex items-center justify-between gap-2">
        <p class="text-[11px] text-slate-500">{{ t('environmentWizard.trial.hint') }}</p>
        <UButton
          size="xs"
          variant="soft"
          color="neutral"
          icon="i-lucide-play"
          :loading="store.trialing"
          :disabled="store.trialStarted"
          data-testid="env-setup-trial"
          @click="store.trialProvision()"
        >
          {{ t('environmentWizard.trial.run') }}
        </UButton>
      </div>
      <p v-if="store.trialError" class="text-[11px] text-rose-300/80">{{ store.trialError }}</p>
      <ProvisioningLogsDrawer v-if="store.trialStarted" subsystem="environment" />
    </template>

    <JourneyStepNav :go-back="goBack">
      <template #primary>
        <UButton
          color="neutral"
          variant="soft"
          icon="i-lucide-check"
          data-testid="env-setup-done"
          @click="exit('advance')"
        >
          {{ t('common.done') }}
        </UButton>
      </template>
    </JourneyStepNav>
  </section>
</template>
