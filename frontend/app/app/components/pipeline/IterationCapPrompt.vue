<script setup lang="ts">
import type { IterationCapChoice } from '~/types/execution'

// The shared "iteration cap reached" decision surface. An iterative agent gate that
// spent its budget with the bar still unmet parks for a human instead of getting
// stuck, offering the same three choices everywhere: one more round, proceed anyway,
// or stop and reset the task. Used by both the requirements-review window and the
// companion step detail (Spec Reviewer / Reviewer / Architect Companion), so the two
// gates present an identical choice rather than each rolling its own.
withDefaults(
  defineProps<{
    heading: string
    detail: string
    loading?: boolean
    extraRoundLabel?: string
    proceedLabel?: string
    stopLabel?: string
  }>(),
  {
    loading: false,
    extraRoundLabel: 'One more round',
    proceedLabel: 'Proceed anyway',
    stopLabel: 'Stop & reset task',
  },
)

const emit = defineEmits<{ resolve: [choice: IterationCapChoice] }>()
</script>

<template>
  <div class="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-200">
    <div class="flex items-center gap-2 font-medium">
      <UIcon name="i-lucide-alert-triangle" class="h-5 w-5 shrink-0" />
      {{ heading }}
    </div>
    <p class="mt-1 text-[12px] text-amber-200/80">{{ detail }}</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <UButton
        color="primary"
        variant="soft"
        size="xs"
        icon="i-lucide-rotate-cw"
        :loading="loading"
        @click="emit('resolve', 'extra-round')"
      >
        {{ extraRoundLabel }}
      </UButton>
      <UButton
        color="warning"
        variant="soft"
        size="xs"
        icon="i-lucide-arrow-right"
        :loading="loading"
        @click="emit('resolve', 'proceed')"
      >
        {{ proceedLabel }}
      </UButton>
      <UButton
        color="error"
        variant="soft"
        size="xs"
        icon="i-lucide-undo"
        :loading="loading"
        @click="emit('resolve', 'stop-reset')"
      >
        {{ stopLabel }}
      </UButton>
    </div>
  </div>
</template>
