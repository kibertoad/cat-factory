<script setup lang="ts">
import type { Block } from '~/types/domain'
import ScenarioCard from '~/components/scenarios/ScenarioCard.vue'

// The current set of acceptance scenarios for a task, grouped by the feature
// each verifies. Scenarios are drafted from the task's requirements (its
// description + any linked PRDs) by the acceptance agent, then refined here.
// "Generate Playwright tests" is idempotent: it only covers scenarios that do
// not already have a test, matching the playwright agent's additive contract.
const props = defineProps<{ block: Block }>()

const scenarios = useScenariosStore()
const confluence = useConfluenceStore()
const board = useBoardStore()
const toast = useToast()

const features = computed(() => props.block.features ?? [])

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
  const docs = confluence.available ? confluence.docsForBlock(props.block.id) : []
  return docs.map((d) => d.title)
}

function draft(feature: string) {
  const created = scenarios.generateForFeature(feature, {
    description: props.block.description,
    requirements: requirementsFor(),
  })
  toast.add({
    title: created.length
      ? `Drafted ${created.length} scenario${created.length === 1 ? '' : 's'}`
      : 'Scenarios already drafted',
    description: created.length
      ? `From the requirements for “${feature}”.`
      : 'Every standard scenario for this feature already exists.',
    icon: 'i-lucide-clipboard-check',
  })
}

function generateTests(feature: string) {
  const created = scenarios.generatePlaywrightTests(feature)
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

function addBlank(feature: string) {
  scenarios.addScenario({ feature })
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Acceptance scenarios
      </span>
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

    <p v-if="!features.length" class="text-[11px] text-slate-500">
      Add a feature above to draft acceptance scenarios from this task's requirements.
    </p>

    <div v-for="feature in features" :key="feature" class="space-y-2">
      <!-- feature header + actions -->
      <div class="flex items-center gap-1.5">
        <UIcon name="i-lucide-puzzle" class="h-3.5 w-3.5 shrink-0 text-emerald-400" />
        <span class="truncate text-xs font-medium text-slate-200">{{ feature }}</span>
        <UBadge color="neutral" variant="subtle" size="sm">
          {{ scenarios.scenariosForFeature(feature).length }}
        </UBadge>
        <div class="ml-auto flex items-center gap-1">
          <UButton
            color="primary"
            variant="ghost"
            size="xs"
            icon="i-lucide-clipboard-check"
            title="Draft scenarios from requirements"
            @click="draft(feature)"
          />
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            icon="i-lucide-plus"
            title="Add a blank scenario"
            @click="addBlank(feature)"
          />
          <UButton
            v-if="scenarios.scenariosForFeature(feature).length"
            color="neutral"
            variant="soft"
            size="xs"
            icon="i-lucide-theater"
            :title="`Generate Playwright tests (${scenarios.untested(feature)} new)`"
            @click="generateTests(feature)"
          >
            Tests
            <UBadge
              v-if="scenarios.untested(feature)"
              color="primary"
              variant="solid"
              size="sm"
              class="ml-0.5"
            >
              {{ scenarios.untested(feature) }}
            </UBadge>
          </UButton>
        </div>
      </div>

      <!-- the current set of scenarios for this feature -->
      <div v-if="scenarios.scenariosForFeature(feature).length" class="space-y-2">
        <ScenarioCard
          v-for="scenario in scenarios.scenariosForFeature(feature)"
          :key="scenario.id"
          :scenario="scenario"
        />
      </div>
      <p v-else class="pl-5 text-[11px] text-slate-500">
        No scenarios yet — draft them from requirements or add one.
      </p>
    </div>
  </div>
</template>
