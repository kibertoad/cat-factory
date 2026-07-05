<script setup lang="ts">
import { ref, computed } from 'vue'

// Shared "Restart pipeline from this step" control.
//
// The restart action is step-generic — it lives on the execution engine, not on any one
// agent kind — but a pipeline step opens in several different windows: the generic prose
// panel (AgentStepDetail) AND the dedicated result views (the tester report, the CI /
// conflicts gate, the requirements review). The restart affordance was originally bolted
// onto the prose panel alone, so clicking a step that routes to a dedicated window showed
// no way to restart. Centralising it here keeps the two-click confirm + the gating
// identical across every window, so the control is reachable from every step a human can
// click into.
//
// Re-runs the pipeline from this step onward: the server resets this step + every later
// step's iteration counters and re-drives a fresh run, preserving the earlier steps'
// outputs as handoff context. Destructive (later steps' results are dropped), so it's a
// two-click confirm. Renders nothing when there's no run behind the view (an off-path
// open, e.g. the inspector's pre-start requirements review) or while THIS step is parked
// on an unresolved approval gate (the approval rail owns that interaction).
const props = defineProps<{
  instanceId: string | null
  stepIndex: number | null
}>()
const emit = defineEmits<{ restarted: [] }>()

const execution = useExecutionStore()
const { t } = useI18n()

const instance = computed(() =>
  props.instanceId ? execution.getInstance(props.instanceId) : undefined,
)
const step = computed(() =>
  instance.value && props.stepIndex !== null
    ? (instance.value.steps[props.stepIndex] ?? null)
    : null,
)
const approvalPending = computed(() => step.value?.approval?.status === 'pending')
const canRestart = computed(
  () => !!instance.value && props.stepIndex !== null && !approvalPending.value,
)

const armed = ref(false)
const restarting = ref(false)
async function restart() {
  if (!instance.value || props.stepIndex === null || restarting.value) return
  restarting.value = true
  try {
    await execution.restartFromStep(instance.value.id, props.stepIndex)
    emit('restarted')
  } finally {
    restarting.value = false
    armed.value = false
  }
}
</script>

<template>
  <template v-if="canRestart">
    <UButton
      v-if="!armed"
      icon="i-lucide-rotate-ccw"
      color="neutral"
      variant="ghost"
      size="sm"
      :title="t('panels.stepRestart.restartFromStep')"
      @click="
        () => {
          armed = true
        }
      "
    />
    <template v-else>
      <UButton
        color="warning"
        variant="soft"
        size="sm"
        icon="i-lucide-rotate-ccw"
        :loading="restarting"
        @click="restart"
      >
        {{ t('panels.stepRestart.restartFromHere') }}
      </UButton>
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        :disabled="restarting"
        @click="
          () => {
            armed = false
          }
        "
      >
        {{ t('common.cancel') }}
      </UButton>
    </template>
  </template>
</template>
