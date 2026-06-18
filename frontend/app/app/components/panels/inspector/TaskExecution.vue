<script setup lang="ts">
import type { Block } from '~/types/domain'
import { AGENT_BY_KIND } from '~/utils/catalog'
import AgentFailureCard from '~/components/board/AgentFailureCard.vue'

const props = defineProps<{ block: Block }>()

const execution = useExecutionStore()
const agentRuns = useAgentRunsStore()
const ui = useUiStore()
const models = useModelsStore()

const instance = computed(() => execution.getInstance(props.block.executionId))

// A failed pipeline run surfaces the shared failure banner + retry — the
// execution failure surface that the old `pr_ready` flip used to hide.
const failedRun = computed(() => {
  const run = agentRuns.byBlock[props.block.id]
  return run && run.status === 'failed' ? run : null
})

const pr = computed(() => props.block.pullRequest)
/** A PR is merged once the block is `done`; otherwise it is open awaiting merge. */
const prMerged = computed(() => props.block.status === 'done')
const prLabel = computed(() => {
  const number = pr.value?.number
  return number ? `PR #${number}` : 'Pull request'
})

const stepLabel: Record<string, string> = {
  pending: 'Pending',
  working: 'Working',
  waiting_decision: 'Needs decision',
  done: 'Done',
}

/** A gated step parked for approval reads "Needs approval", not "Needs decision". */
function labelForStep(s: { state: string; approval?: { status: string } | null }) {
  if (s.approval?.status === 'pending') return 'Needs approval'
  return stepLabel[s.state]
}

function openDecisionFor(decisionId: string) {
  if (instance.value) ui.openDecision(instance.value.id, decisionId)
}

function openApprovalFor(approvalId: string) {
  if (instance.value) ui.openApproval(instance.value.id, approvalId)
}

// Clicking any agent opens its step-detail overlay — execution metadata (state,
// timing, model, subtasks) plus the full prose output when the agent produced one.
function openStep(i: number) {
  if (instance.value) ui.openStepDetail(instance.value.id, i)
}
</script>

<template>
  <div class="space-y-4">
    <!-- running pipeline -->
    <div v-if="instance">
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {{ instance.pipelineName }}
        </span>
        <UButton
          icon="i-lucide-square"
          color="error"
          variant="ghost"
          size="xs"
          @click="execution.cancel(block.id)"
        >
          Stop
        </UButton>
      </div>
      <ul class="space-y-1">
        <li
          v-for="(s, i) in instance.steps"
          :key="i"
          class="rounded-md px-2 py-1"
          :class="i === instance.currentStep ? 'bg-slate-800/70' : ''"
        >
          <div class="flex items-center gap-2">
            <!-- Every agent is clickable: it opens the step-detail overlay (timing,
                 model, subtasks + the prose output when there is one). -->
            <button
              type="button"
              class="flex min-w-0 cursor-pointer items-center gap-2 text-left transition hover:text-white"
              :title="s.output ? 'View details & read output' : 'View step details'"
              @click="openStep(i)"
            >
              <UIcon
                :name="AGENT_BY_KIND[s.agentKind].icon"
                class="h-4 w-4 shrink-0"
                :style="{ color: AGENT_BY_KIND[s.agentKind].color }"
              />
              <span class="truncate text-xs text-slate-200">
                {{ AGENT_BY_KIND[s.agentKind].label }}
              </span>
              <UIcon
                :name="s.output ? 'i-lucide-book-open-text' : 'i-lucide-info'"
                class="h-3.5 w-3.5 shrink-0 text-slate-500"
              />
            </button>
            <span
              v-if="s.subtasks && s.subtasks.total > 0"
              class="ml-auto font-mono text-[10px] tabular-nums text-slate-300"
              :title="
                s.subtasks.inProgress > 0
                  ? `${s.subtasks.completed} of ${s.subtasks.total} subtasks done, ${s.subtasks.inProgress} in progress`
                  : `${s.subtasks.completed} of ${s.subtasks.total} subtasks done`
              "
            >
              {{ s.subtasks.completed }}/{{ s.subtasks.total }}
            </span>
            <span class="text-[10px] text-slate-400" :class="{ 'ml-auto': !s.subtasks }">
              {{ labelForStep(s) }}
            </span>
            <UButton
              v-if="s.decision && !s.decision.chosen"
              color="warning"
              variant="soft"
              size="xs"
              icon="i-lucide-circle-help"
              @click="openDecisionFor(s.decision.id)"
            >
              Resolve
            </UButton>
            <UButton
              v-else-if="s.approval && s.approval.status === 'pending'"
              color="warning"
              variant="soft"
              size="xs"
              icon="i-lucide-shield-check"
              @click="openApprovalFor(s.approval.id)"
            >
              Approve
            </UButton>
          </div>
          <div
            v-if="s.subtasks && s.subtasks.total > 0"
            class="mt-1 ml-6 h-1 overflow-hidden rounded-full bg-slate-700/60"
          >
            <div
              class="h-full rounded-full bg-indigo-400 transition-all duration-500"
              :style="{ width: `${(s.subtasks.completed / s.subtasks.total) * 100}%` }"
            />
          </div>
          <div
            v-if="s.model"
            class="mt-0.5 flex items-center gap-1 pl-6 text-[10px] text-slate-500"
            :title="s.model"
          >
            <UIcon name="i-lucide-cpu" class="h-3 w-3" />
            {{ models.labelForRef(s.model) }}
          </div>
          <!-- Prompt-fragment standards the library selected for this step. -->
          <div
            v-if="s.selectedFragmentIds && s.selectedFragmentIds.length"
            class="mt-0.5 flex flex-wrap items-center gap-1 pl-6 text-[10px] text-slate-500"
            :title="`Best-practice fragments folded into this step: ${s.selectedFragmentIds.join(', ')}`"
          >
            <UIcon name="i-lucide-book-marked" class="h-3 w-3 shrink-0" />
            <span>{{ s.selectedFragmentIds.length }} standard(s) applied</span>
          </div>
        </li>
      </ul>
    </div>

    <!-- failed run: shared failure banner + retry -->
    <AgentFailureCard v-if="failedRun" :run="failedRun" />

    <!-- Open PR: link straight to it on GitHub -->
    <div v-if="pr" class="space-y-2">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Pull request
      </span>
      <UButton
        :to="pr.url"
        target="_blank"
        rel="noopener"
        external
        color="neutral"
        variant="soft"
        size="sm"
        icon="i-lucide-git-pull-request"
        trailing-icon="i-lucide-external-link"
        block
      >
        <span class="flex w-full items-center gap-2">
          {{ prLabel }}
          <UBadge :color="prMerged ? 'success' : 'info'" variant="subtle" size="sm" class="ml-auto">
            {{ prMerged ? 'Merged' : 'Open' }}
          </UBadge>
        </span>
      </UButton>
      <p v-if="pr.branch" class="flex items-center gap-1 truncate text-[10px] text-slate-500">
        <UIcon name="i-lucide-git-branch" class="h-3 w-3 shrink-0" />
        <span class="truncate" :title="pr.branch">{{ pr.branch }}</span>
      </p>
    </div>

    <!-- PR ready: merge -->
    <UButton
      v-if="block.status === 'pr_ready'"
      color="success"
      variant="solid"
      size="sm"
      icon="i-lucide-git-merge"
      block
      @click="execution.mergePr(block.id)"
    >
      Merge PR
    </UButton>
  </div>
</template>
