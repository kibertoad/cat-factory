<script setup lang="ts">
// Posts the refined requirements back to the tracker issue(s) the task came from, as a comment on
// each: the issue's own description is never rewritten. Shown only when the block has a linked
// issue, and only on a person's click, so nothing lands on someone's tracker unasked.
import type {
  RefinedRequirementsPostOutcome,
  RefinedRequirementsPostResult,
} from '@cat-factory/contracts'

const props = defineProps<{ blockId: string; disabled?: boolean }>()

const { t } = useI18n()
const tasks = useTasksStore()
const requirements = useRequirementsStore()
const actionToast = useActionToast()
const { present } = usePipelineErrorToast()

onMounted(() => {
  tasks.loadTasks().catch(() => {})
})

const linked = computed(() => tasks.tasksForBlock(props.blockId))
const posting = ref(false)
// The per-issue outcomes of the last post, listed under the button: a toast description renders
// as one line of plain text, which runs several issues together.
const outcomes = ref<RefinedRequirementsPostResult['issues']>([])

const OUTCOME_KEYS: Record<RefinedRequirementsPostOutcome, string> = {
  posted: 'requirements.postToIssues.outcome.posted',
  already_posted: 'requirements.postToIssues.outcome.already_posted',
  in_flight: 'requirements.postToIssues.outcome.in_flight',
  failed: 'requirements.postToIssues.outcome.failed',
  unsupported: 'requirements.postToIssues.outcome.unsupported',
}

const OUTCOME_COLORS: Record<RefinedRequirementsPostOutcome, string> = {
  posted: 'text-success',
  already_posted: 'text-dimmed',
  in_flight: 'text-info',
  failed: 'text-error',
  unsupported: 'text-warning',
}

async function post() {
  if (posting.value) return
  posting.value = true
  try {
    const { issues } = await requirements.postToIssues(props.blockId)
    outcomes.value = issues
    const seen = new Set(issues.map((issue) => issue.outcome))
    if (seen.has('failed') || seen.has('unsupported')) {
      actionToast.warning('requirements.postToIssues.toast.partial')
    } else if (seen.has('posted')) {
      actionToast.success('requirements.postToIssues.toast.posted')
    } else if (seen.has('in_flight')) {
      actionToast.info('requirements.postToIssues.toast.inFlight')
    } else {
      actionToast.info('requirements.postToIssues.toast.nothingNew')
    }
  } catch (e) {
    present(e, 'requirements.postToIssues.error')
  } finally {
    posting.value = false
  }
}
</script>

<template>
  <div v-if="linked.length > 0" class="mb-3">
    <div class="flex flex-wrap items-center gap-3">
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-message-square-share"
        :loading="posting"
        :disabled="disabled || posting"
        @click="post"
      >
        {{ t('requirements.postToIssues.action') }}
      </UButton>
      <span class="text-2xs text-dimmed">{{ t('requirements.postToIssues.hint') }}</span>
    </div>
    <ul v-if="outcomes.length > 0" class="mt-2 space-y-0.5 text-2xs">
      <li v-for="issue in outcomes" :key="`${issue.source}:${issue.externalId}`">
        <span class="font-mono">{{ issue.externalId }}</span>
        <span :class="OUTCOME_COLORS[issue.outcome]">: {{ t(OUTCOME_KEYS[issue.outcome]) }}</span>
      </li>
    </ul>
  </div>
</template>
