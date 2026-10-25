<script setup lang="ts">
// The SPA's one INLINE failure render: the toast funnel's copy, laid out in place. A panel whose
// load failed, a message above Retry, a failed probe all show this, so a failure reads the same
// whether it arrives as a toast or as text in a panel.
//
// Same split as the toast (`usePipelineErrorToast`): an optional title naming what failed, then
// the translated description from `describeFailure`, and the backend's raw prose plus the request
// id one click away behind "Show details". Raw text is never the first thing shown, and never
// dropped either: it often names the remedy, and the request id joins it to the server log.
import { computed, ref, watch } from 'vue'
import {
  failureDetail,
  type DescribedFailure,
} from '~/composables/pipelineErrorToast/describeFailure'

const props = withDefaults(
  defineProps<{
    /** The classified failure; null renders nothing. */
    failure: DescribedFailure | null
    /** Already-resolved copy naming what failed, shown above the description. */
    title?: string
  }>(),
  { title: undefined },
)

const { t } = useI18n()

const detail = computed(() => (props.failure ? failureDetail(props.failure, t) : ''))
const showDetail = ref(false)
// A new failure starts folded again, so a retry that fails differently never shows stale detail.
watch(
  () => props.failure,
  () => {
    showDetail.value = false
  },
)
</script>

<template>
  <div v-if="failure" class="space-y-0.5" role="alert" data-testid="failure-message">
    <p v-if="title" class="font-medium break-words">{{ title }}</p>
    <p class="break-words" data-testid="failure-message-description">
      {{ t(failure.descriptionKey) }}
    </p>
    <UButton
      v-if="detail && !showDetail"
      color="neutral"
      variant="link"
      size="xs"
      class="p-0"
      data-testid="failure-message-show-detail"
      @click="showDetail = true"
    >
      {{ t('errors.generic.showDetail') }}
    </UButton>
    <p
      v-if="detail && showDetail"
      class="font-mono text-3xs break-all opacity-80 select-text"
      data-testid="failure-message-detail"
    >
      {{ detail }}
    </p>
  </div>
</template>
