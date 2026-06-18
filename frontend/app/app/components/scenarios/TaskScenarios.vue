<script setup lang="ts">
import type { Block } from '~/types/domain'
import ScenarioCard from '~/components/scenarios/ScenarioCard.vue'

// The current set of acceptance scenarios for a task. Scenarios are drafted from
// the task's requirements (its description + any linked PRDs) by the acceptance
// agent, then refined here. They are freeform — a single flat set per task — so
// they read straight from the task's intent. "Generate Playwright tests" is
// idempotent: it only covers scenarios that do not already have a test, matching
// the playwright agent's additive contract.
const props = defineProps<{ block: Block }>()

const scenarios = useScenariosStore()
const documents = useDocumentsStore()
const board = useBoardStore()
const toast = useToast()

const items = computed(() => scenarios.scenariosForBlock(props.block.id))

// Where this block's generated tests run. The choice is folded into the
// acceptance-testing agents' prompt at run time.
const TEST_TARGETS = [
  { value: 'github_actions', label: 'Project CI', icon: 'i-lucide-github' },
  { value: 'ephemeral_env', label: 'Ephemeral env', icon: 'i-lucide-container' },
] as const

function setTarget(value: Block['testTarget']) {
  board.updateBlock(props.block.id, { testTarget: value })
}

/** Requirement context fed to scenario generation: the block intent + PRD titles. */
function requirementsFor(): string[] {
  const docs = documents.available ? documents.docsForBlock(props.block.id) : []
  return docs.map((d) => d.title)
}

function draft() {
  const created = scenarios.generateForBlock(props.block.id, {
    subject: props.block.title,
    description: props.block.description,
    requirements: requirementsFor(),
  })
  toast.add({
    title: created.length
      ? `Drafted ${created.length} scenario${created.length === 1 ? '' : 's'}`
      : 'Scenarios already drafted',
    description: created.length
      ? `From the requirements for “${props.block.title}”.`
      : 'Every standard scenario for this task already exists.',
    icon: 'i-lucide-clipboard-check',
  })
}

function generateTests() {
  const created = scenarios.generatePlaywrightTests(props.block.id)
  toast.add({
    title: created.length
      ? `Generated ${created.length} Playwright test${created.length === 1 ? '' : 's'}`
      : 'No new tests needed',
    description: created.length
      ? 'New test files committed for scenarios that lacked one.'
      : 'Every scenario already has a Playwright test.',
    icon: 'i-lucide-theater',
  })
}

function addBlank() {
  scenarios.addScenario({ blockId: props.block.id })
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-1.5">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Acceptance scenarios
      </span>
      <UBadge v-if="items.length" color="neutral" variant="subtle" size="sm">
        {{ items.length }}
      </UBadge>
      <div class="ml-auto flex items-center gap-1">
        <UButton
          color="primary"
          variant="ghost"
          size="xs"
          icon="i-lucide-clipboard-check"
          title="Draft scenarios from requirements"
          @click="draft"
        />
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-plus"
          title="Add a blank scenario"
          @click="addBlank"
        />
        <UButton
          v-if="items.length"
          color="neutral"
          variant="soft"
          size="xs"
          icon="i-lucide-theater"
          :title="`Generate Playwright tests (${scenarios.untested(block.id)} new)`"
          @click="generateTests"
        >
          Tests
          <UBadge
            v-if="scenarios.untested(block.id)"
            color="primary"
            variant="solid"
            size="sm"
            class="ml-0.5"
          >
            {{ scenarios.untested(block.id) }}
          </UBadge>
        </UButton>
      </div>
    </div>

    <!-- where the generated tests run (per block) -->
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

    <p v-if="!items.length" class="text-[11px] text-slate-500">
      No scenarios yet — draft them from this task's requirements or add one.
    </p>

    <div v-else class="space-y-2">
      <ScenarioCard v-for="scenario in items" :key="scenario.id" :scenario="scenario" />
    </div>
  </div>
</template>
