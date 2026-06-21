<script setup lang="ts">
import type { Block } from '~/types/domain'

// Where this task's generated acceptance tests run. The structured acceptance
// SCENARIOS themselves are authored in the service spec (by the `spec-writer`,
// reviewed on its gated step) and derived into Gherkin; this only records the
// execution target, which is folded into the `playwright` agent's prompt at run time.
const props = defineProps<{ block: Block }>()

const board = useBoardStore()

const TEST_TARGETS = [
  { value: 'github_actions', label: 'Project CI', icon: 'i-lucide-github' },
  { value: 'ephemeral_env', label: 'Ephemeral env', icon: 'i-lucide-container' },
] as const

function setTarget(value: Block['testTarget']) {
  board.updateBlock(props.block.id, { testTarget: value })
}
</script>

<template>
  <div class="space-y-2">
    <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
      Acceptance tests
    </div>
    <div>
      <div class="mb-1 text-[11px] text-slate-500">Run tests in</div>
      <div class="flex gap-1">
        <UButton
          v-for="target in TEST_TARGETS"
          :key="target.value"
          :color="block.testTarget === target.value ? 'primary' : 'neutral'"
          :variant="block.testTarget === target.value ? 'soft' : 'ghost'"
          size="xs"
          :icon="target.icon"
          class="flex-1 justify-center"
          @click="setTarget(target.value)"
        >
          {{ target.label }}
        </UButton>
      </div>
    </div>
  </div>
</template>
