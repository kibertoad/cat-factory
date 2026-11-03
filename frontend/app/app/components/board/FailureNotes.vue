<script setup lang="ts">
// The body of a failure's Details toggle: the backend's message, its notes for the operator
// (the per-kind `hint`) and the full output, each under its own label. The cause line above the
// toggle is the SPA's own translated copy (`presentFailure`), so this is the one place a task view
// shows the backend's English text. Used by the failure block (`AgentFailureCard`) and by the two
// failure lists (`FailureHistoryList`, `StepExecutionHistory`). The host owns the toggle, so the
// block can put it in its action row. The default slot holds extra controls (Retry when it is not
// the block's action, Model activity).
import type { AgentFailure } from '~/types/domain'
import FailureOutput from '~/components/board/FailureOutput.vue'
import { failureOutput } from '~/utils/failureCause'

const props = defineProps<{
  failure: Pick<AgentFailure, 'message' | 'hint' | 'detail'>
  /** `error` inside the red failure block, `neutral` inside a list of earlier failures. */
  tone: 'error' | 'neutral'
}>()

const { t } = useI18n()

const fullOutput = computed(() => failureOutput(props.failure))
const labelClass = computed(() =>
  props.tone === 'error' ? 'text-app-error-400/80' : 'text-dimmed',
)
const textClass = computed(() => (props.tone === 'error' ? 'text-app-error-200/90' : 'text-toned'))
const preClass = computed(() =>
  props.tone === 'error' ? 'bg-app-error-950/60 text-app-error-200/80' : 'bg-app-950/80 text-muted',
)
</script>

<template>
  <div class="mt-2 space-y-2 text-3xs leading-snug" data-testid="failure-notes">
    <section>
      <p class="font-medium" :class="labelClass">{{ t('board.failure.detailsMessage') }}</p>
      <p class="mt-0.5 whitespace-pre-line break-words" :class="textClass">
        {{ failure.message }}
      </p>
    </section>

    <section v-if="failure.hint">
      <p class="font-medium" :class="labelClass">{{ t('board.failure.detailsHint') }}</p>
      <p class="mt-0.5" :class="textClass">{{ failure.hint }}</p>
    </section>

    <section v-if="fullOutput">
      <p class="font-medium" :class="labelClass">{{ t('board.failure.detailsFull') }}</p>
      <FailureOutput :text="fullOutput" :pre-class="preClass" />
    </section>

    <slot />
  </div>
</template>
