<script setup lang="ts">
// A compact, read-only summary of a pipeline: its name, prose description (when authored), and the
// ordered list of enabled agent steps rendered as icon+label chips (a human-gated step is flagged).
// Shared by the pipeline pickers' hover preview so "what a pipeline consists of" is explained the
// same way everywhere. Resolves each step's display metadata through the single `agentKindMeta`
// path (via <AgentKindIcon>), so a system/custom kind can never blow up the renderer.
import { computed } from 'vue'
import type { Pipeline } from '~/types/domain'
import { pipelineDisplaySteps } from '~/utils/pipeline'

const props = defineProps<{ pipeline: Pipeline }>()
const { t } = useI18n()

const steps = computed(() => pipelineDisplaySteps(props.pipeline))
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
    <div>
      <div class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-500">
        <UIcon name="i-lucide-workflow" class="h-3 w-3" />
        {{ t('pipeline.preview.stepCount', { count: steps.length }, steps.length) }}
      </div>
      <ol class="flex flex-wrap items-center gap-1">
        <li
          v-for="(s, i) in steps"
          :key="i"
          class="inline-flex items-center gap-1 rounded bg-slate-800/70 px-1.5 py-0.5"
        >
          <AgentKindIcon :kind="s.kind" show-label icon-class="h-3.5 w-3.5" />
          <UIcon
            v-if="s.gated"
            name="i-lucide-shield-check"
            class="h-3 w-3 text-amber-400"
            :title="t('pipeline.preview.gated')"
          />
        </li>
      </ol>
    </div>
  </div>
</template>
