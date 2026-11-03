<script setup lang="ts">
// Writes the refined requirements into the description of the tracker issue(s) the task came
// from, replacing it (the tracker keeps the previous description in its history). Shown only when
// the block has a linked issue. The workspace can also have it happen automatically as the review
// settles; either way the last outcome per issue is listed under the button.
import type {
  RefinedRequirementsIssueOutcome,
  RefinedRequirementsWritebackOutcome,
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
const updating = ref(false)
// The answer to this window's own click, shown until the reloaded review carries it: the record is
// written best-effort, so the response is the one outcome that is certain to be there.
const clicked = ref<RefinedRequirementsIssueOutcome[] | null>(null)
const recorded = computed(() => requirements.reviewFor(props.blockId)?.issueWriteback ?? null)
const outcomes = computed(() => clicked.value ?? recorded.value?.issues ?? [])
const automatic = computed(() => !clicked.value && recorded.value?.trigger === 'automatic')

const OUTCOME_KEYS: Record<RefinedRequirementsWritebackOutcome, string> = {
  updated: 'requirements.updateIssues.outcome.updated',
  already_current: 'requirements.updateIssues.outcome.already_current',
  failed: 'requirements.updateIssues.outcome.failed',
  unsupported: 'requirements.updateIssues.outcome.unsupported',
}

const OUTCOME_COLORS: Record<RefinedRequirementsWritebackOutcome, string> = {
  updated: 'text-success',
  already_current: 'text-dimmed',
  failed: 'text-error',
  unsupported: 'text-warning',
}

async function update() {
  if (updating.value) return
  updating.value = true
  try {
    const { issues } = await requirements.updateLinkedIssues(props.blockId)
    clicked.value = issues
    const seen = new Set(issues.map((issue) => issue.outcome))
    if (seen.has('failed') || seen.has('unsupported')) {
      actionToast.warning('requirements.updateIssues.toast.partial')
    } else if (seen.has('updated')) {
      actionToast.success('requirements.updateIssues.toast.updated')
    } else {
      actionToast.info('requirements.updateIssues.toast.nothingNew')
    }
  } catch (e) {
    present(e, 'requirements.updateIssues.error')
  } finally {
    updating.value = false
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
        icon="i-lucide-file-pen-line"
        :loading="updating"
        :disabled="disabled || updating"
        @click="update"
      >
        {{ t('requirements.updateIssues.action') }}
      </UButton>
      <span class="text-2xs text-dimmed">{{ t('requirements.updateIssues.hint') }}</span>
    </div>
    <div v-if="outcomes.length > 0" class="mt-2 text-2xs">
      <p v-if="automatic" class="text-dimmed">{{ t('requirements.updateIssues.automatic') }}</p>
      <ul class="space-y-0.5">
        <li v-for="issue in outcomes" :key="`${issue.source}:${issue.externalId}`">
          <span class="font-mono">{{ issue.externalId }}</span>
          <span :class="OUTCOME_COLORS[issue.outcome]">: {{ t(OUTCOME_KEYS[issue.outcome]) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
