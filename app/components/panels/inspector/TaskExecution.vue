<script setup lang="ts">
import type { Block } from '~/types/domain'
import { AGENT_BY_KIND } from '~/utils/catalog'

const props = defineProps<{ block: Block }>()

const execution = useExecutionStore()
const ui = useUiStore()
const models = useModelsStore()

const instance = computed(() => execution.getInstance(props.block.executionId))

const stepLabel: Record<string, string> = {
  pending: 'Pending',
  working: 'Working',
  waiting_decision: 'Needs decision',
  done: 'Done',
}

function openDecisionFor(decisionId: string) {
  if (instance.value) ui.openDecision(instance.value.id, decisionId)
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
            <UIcon
              :name="AGENT_BY_KIND[s.agentKind].icon"
              class="h-4 w-4"
              :style="{ color: AGENT_BY_KIND[s.agentKind].color }"
            />
            <span class="text-xs text-slate-200">{{ AGENT_BY_KIND[s.agentKind].label }}</span>
            <span class="ml-auto text-[10px] text-slate-400">{{ stepLabel[s.state] }}</span>
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
          </div>
          <div
            v-if="s.model"
            class="mt-0.5 flex items-center gap-1 pl-6 text-[10px] text-slate-500"
            :title="s.model"
          >
            <UIcon name="i-lucide-cpu" class="h-3 w-3" />
            {{ models.labelForRef(s.model) }}
          </div>
        </li>
      </ul>
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
