<script setup lang="ts">
// The environment-setup journey's PICK step (slice 3 of the modular-vue adoption).
// Lists the workspace's service frames; choosing one fires the journey's `next`
// exit carrying the frame id, which the transition folds into journey state and
// advances to the review step. Rendered by `JourneyOutlet`, so it receives the
// `ModuleEntryProps` (`input` / `exit` / `goBack`) as attributes.
import type { EnvSelectOutput } from '~/modular/journeys/environmentSetup.logic'

defineProps<{
  input: { frameId: string | null }
  exit: (name: 'select', output: EnvSelectOutput) => void
}>()

const store = useEnvironmentWizardStore()
const { t } = useI18n()
</script>

<template>
  <section class="space-y-3" data-testid="env-setup-step-pick">
    <p class="text-sm text-slate-400">{{ t('environmentWizard.pick.intro') }}</p>
    <p v-if="!store.serviceFrames.length" class="text-sm text-slate-500">
      {{ t('environmentWizard.pick.empty') }}
    </p>
    <div v-else class="space-y-1.5">
      <UButton
        v-for="frame in store.serviceFrames"
        :key="frame.id"
        block
        color="neutral"
        variant="soft"
        class="justify-start"
        icon="i-lucide-box"
        :data-testid="`env-setup-frame-${frame.id}`"
        @click="exit('select', { frameId: frame.id })"
      >
        {{ frame.title }}
      </UButton>
    </div>
  </section>
</template>
