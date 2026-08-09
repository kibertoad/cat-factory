<script setup lang="ts">
// A compact, read-only summary of a pipeline: its name, prose description (when authored), and the
// ordered list of steps it will actually run — each a numbered row carrying the agent's icon, label
// and catalog description, with the human approval gates flagged. The FULL list, not a step count:
// "what does this pipeline actually do" is the only question a picker's preview pane exists to
// answer, and a row of interchangeable chips answers just "how many". Shared by the pipeline
// pickers everywhere a pipeline is chosen, so the explanation is identical on every surface.
// Resolves each step's display metadata through the single `agentKindMeta` path (via
// <AgentKindIcon> and {@link stepDescription}), so a system/custom kind can never blow up the
// renderer.
import { computed } from 'vue'
import type { Pipeline } from '~/types/domain'
import { agentKindMeta } from '~/utils/catalog'
import {
  CONDITION_MARKERS,
  pipelineConditionalCount,
  pipelineDisplaySteps,
  pipelineGateCount,
} from '~/utils/pipeline'
import AgentKindIcon from '~/components/pipeline/AgentKindIcon.vue'

const props = defineProps<{ pipeline: Pipeline }>()
const { t } = useI18n()

const steps = computed(() => pipelineDisplaySteps(props.pipeline))
const gateCount = computed(() => pipelineGateCount(props.pipeline))
const conditionalCount = computed(() => pipelineConditionalCount(props.pipeline))

/** What the agent at this step does — the same catalog prose the palette and step tooltips use. */
function stepDescription(kind: string): string {
  return agentKindMeta(kind).description
}
</script>

<template>
  <div class="space-y-2" data-testid="pipeline-preview">
    <div class="text-sm font-semibold text-slate-100">{{ pipeline.name }}</div>
    <p
      v-if="pipeline.description"
      class="text-[12px] leading-snug text-slate-400"
      data-testid="pipeline-preview-description"
    >
      {{ pipeline.description }}
    </p>

    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-wide text-slate-500"
    >
      <span class="inline-flex items-center gap-1">
        <UIcon name="i-lucide-workflow" class="h-3 w-3" />
        {{ t('pipeline.preview.stepCount', { count: steps.length }, steps.length) }}
      </span>
      <!-- Gates are the reason a run stops for a human, so they earn a headline of their own
           rather than only the per-step marker below. -->
      <span v-if="gateCount" class="inline-flex items-center gap-1 text-amber-500">
        <UIcon name="i-lucide-shield-check" class="h-3 w-3" />
        {{ t('pipeline.preview.gateCount', { count: gateCount }, gateCount) }}
      </span>
      <!-- Conditional steps change what a run of this pipeline actually does from task to task,
           which is exactly what a preview read BEFORE picking has to say out loud. -->
      <span v-if="conditionalCount" class="inline-flex items-center gap-1 text-sky-500">
        <UIcon name="i-lucide-git-branch" class="h-3 w-3" />
        {{ t('pipeline.preview.conditionalCount', { count: conditionalCount }, conditionalCount) }}
      </span>
    </div>

    <!-- The ordered steps. The number column doubles as the flow connector (a rule drawn between
         consecutive numbers), so the list reads as a sequence rather than an unordered set. -->
    <ol>
      <li
        v-for="(s, i) in steps"
        :key="i"
        class="flex gap-2"
        data-testid="pipeline-preview-step"
        :data-step-kind="s.kind"
      >
        <div class="flex flex-col items-center">
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-slate-800 font-mono text-[9px] tabular-nums text-slate-400"
          >
            {{ i + 1 }}
          </span>
          <span v-if="i < steps.length - 1" class="w-px flex-1 bg-slate-800" />
        </div>
        <div class="min-w-0 flex-1 pb-2">
          <div class="flex items-center gap-1">
            <AgentKindIcon :kind="s.kind" show-label icon-class="h-3.5 w-3.5" />
            <UIcon
              v-if="s.gated"
              name="i-lucide-shield-check"
              class="h-3 w-3 shrink-0 text-amber-400"
              :title="t('pipeline.preview.gated')"
            />
            <UIcon
              v-for="c in s.conditions"
              :key="c"
              :name="CONDITION_MARKERS[c].icon"
              class="h-3 w-3 shrink-0 text-sky-400"
              :title="t(CONDITION_MARKERS[c].key)"
            />
          </div>
          <!-- Clamped: the catalog prose runs long for some kinds, and <AgentKindIcon> already
               carries the full text in its hover tooltip. -->
          <p class="line-clamp-2 text-[11px] leading-snug text-slate-500">
            {{ stepDescription(s.kind) }}
          </p>
        </div>
      </li>
    </ol>
  </div>
</template>
