<script setup lang="ts">
// Posts the refined requirements back to the tracker issue(s) the task came from, as a comment on
// each: the issue's own description is never rewritten. Shown only when the block has a linked
// issue, and only on a person's click, so nothing lands on someone's tracker unasked.
import type { RefinedRequirementsPostOutcome } from '@cat-factory/contracts'

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

const OUTCOME_KEYS: Record<RefinedRequirementsPostOutcome, string> = {
  posted: 'requirements.postToIssues.outcome.posted',
  already_posted: 'requirements.postToIssues.outcome.already_posted',
  in_flight: 'requirements.postToIssues.outcome.in_flight',
  failed: 'requirements.postToIssues.outcome.failed',
  unsupported: 'requirements.postToIssues.outcome.unsupported',
}

async function post() {
  if (posting.value) return
  posting.value = true
  try {
    const { issues } = await requirements.postToIssues(props.blockId)
    const description = issues
      .map((issue) => `${issue.externalId}: ${t(OUTCOME_KEYS[issue.outcome])}`)
      .join('\n')
    const outcomes = new Set(issues.map((issue) => issue.outcome))
    if (outcomes.has('failed') || outcomes.has('unsupported')) {
      actionToast.warning('requirements.postToIssues.toast.partial', { description })
    } else if (outcomes.has('posted')) {
      actionToast.success('requirements.postToIssues.toast.posted', { description })
    } else {
      actionToast.info('requirements.postToIssues.toast.nothingNew', { description })
    }
  } catch (e) {
    present(e, 'requirements.postToIssues.error')
  } finally {
    posting.value = false
  }
}
</script>

<template>
  <div v-if="linked.length > 0" class="mb-3 flex flex-wrap items-center gap-3">
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
</template>
