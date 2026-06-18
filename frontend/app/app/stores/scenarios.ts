/* eslint-disable unicorn/no-thenable -- `then` is the Gherkin clause name on plain
   scenario data objects (a string[]), never a thenable callback; these objects
   are never awaited. */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { uid } from '~/utils/catalog'
import type { AcceptanceScenario } from '~/types/domain'

/** Context the acceptance agent draws on when drafting scenarios for a task. */
export interface ScenarioGenerationContext {
  /** A short subject for the generated titles (typically the task title). */
  subject?: string
  /** The block's free-text intent. */
  description?: string
  /** Titles/excerpts of linked requirement docs (PRDs), for traceable scenarios. */
  requirements?: string[]
}

/** Normalise a title into a comparable key (case- and space-insensitive). */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Draft a standard freeform set of acceptance scenarios for a task: the happy
 * path, an error path and an input-validation path. This mirrors what the
 * `acceptance` agent does from requirements — deterministic here so the prototype
 * has something concrete and editable to show. The task subject and any linked
 * requirements are folded into the Given/When/Then so the output is specific.
 */
function draftScenarios(
  blockId: string,
  context: ScenarioGenerationContext = {},
): Omit<AcceptanceScenario, 'id' | 'createdAt'>[] {
  const subject = context.subject?.trim() || 'this task'
  const reqGiven = context.requirements?.length
    ? [`the requirements for "${subject}" (${context.requirements.join('; ')})`]
    : []
  const base = ['a user on the application', ...reqGiven]

  return [
    {
      blockId,
      title: `${subject}: happy path`,
      given: base,
      when: [`the user completes the "${subject}" flow with valid input`],
      then: [`the action succeeds`, `the expected result for "${subject}" is shown`],
      status: 'draft',
      source: 'generated',
      hasPlaywrightTest: false,
    },
    {
      blockId,
      title: `${subject}: invalid input is rejected`,
      given: base,
      when: [`the user attempts the "${subject}" flow with invalid input`],
      then: [`the action is rejected`, `a clear error message is shown`],
      status: 'draft',
      source: 'generated',
      hasPlaywrightTest: false,
    },
    {
      blockId,
      title: `${subject}: required fields are validated`,
      given: base,
      when: [`the user submits the "${subject}" flow with required fields missing`],
      then: [`submission is blocked`, `each missing field is flagged`],
      status: 'draft',
      source: 'generated',
      hasPlaywrightTest: false,
    },
  ]
}

/**
 * The acceptance-scenario catalog. Task-scoped Given/When/Then scenarios that the
 * `acceptance` agent drafts from requirements and the `playwright` agent turns into
 * e2e tests. Authored and refined client-side (persisted locally), this is the data
 * the task's scenario viewer renders.
 */
export const useScenariosStore = defineStore(
  'scenarios',
  () => {
    const scenarios = ref<AcceptanceScenario[]>([])

    /** Scenarios for a single task, oldest first. */
    function scenariosForBlock(blockId: string): AcceptanceScenario[] {
      return scenarios.value
        .filter((s) => s.blockId === blockId)
        .sort((a, b) => a.createdAt - b.createdAt)
    }

    /** True when a task already has at least one scenario. */
    function hasScenarios(blockId: string): boolean {
      return scenarios.value.some((s) => s.blockId === blockId)
    }

    function addScenario(input: {
      blockId: string
      title?: string
      given?: string[]
      when?: string[]
      then?: string[]
      source?: AcceptanceScenario['source']
    }): AcceptanceScenario {
      const scenario: AcceptanceScenario = {
        id: uid('scn'),
        blockId: input.blockId,
        title: input.title?.trim() || 'New scenario',
        given: input.given ?? [],
        when: input.when ?? [],
        then: input.then ?? [],
        status: 'draft',
        source: input.source ?? 'manual',
        hasPlaywrightTest: false,
        createdAt: Date.now(),
      }
      scenarios.value.push(scenario)
      return scenario
    }

    function updateScenario(id: string, patch: Partial<AcceptanceScenario>) {
      const scenario = scenarios.value.find((s) => s.id === id)
      if (!scenario) return
      Object.assign(scenario, patch)
    }

    function removeScenario(id: string) {
      scenarios.value = scenarios.value.filter((s) => s.id !== id)
    }

    /**
     * Draft scenarios for a task from its requirements. Additive: titles that
     * already exist for the task are skipped, so re-running only fills gaps and
     * never clobbers edits. Returns the scenarios actually created.
     */
    function generateForBlock(
      blockId: string,
      context: ScenarioGenerationContext = {},
    ): AcceptanceScenario[] {
      const existing = new Set(scenariosForBlock(blockId).map((s) => normalize(s.title)))
      const created: AcceptanceScenario[] = []
      for (const draft of draftScenarios(blockId, context)) {
        if (existing.has(normalize(draft.title))) continue
        created.push(addScenario({ ...draft, source: 'generated' }))
      }
      return created
    }

    /**
     * "Generate Playwright tests" for a task. Mirrors the `playwright` agent's
     * idempotent contract: only scenarios that don't yet have a test get one, so
     * existing committed tests are never regenerated. Returns the scenarios for
     * which a new test was created.
     */
    function generatePlaywrightTests(blockId: string): AcceptanceScenario[] {
      const created: AcceptanceScenario[] = []
      for (const scenario of scenariosForBlock(blockId)) {
        if (scenario.hasPlaywrightTest) continue
        scenario.hasPlaywrightTest = true
        created.push(scenario)
      }
      return created
    }

    /** Count of scenarios still missing a Playwright test, for a task. */
    const untested = computed(
      () => (blockId: string) =>
        scenariosForBlock(blockId).filter((s) => !s.hasPlaywrightTest).length,
    )

    return {
      scenarios,
      scenariosForBlock,
      hasScenarios,
      untested,
      addScenario,
      updateScenario,
      removeScenario,
      generateForBlock,
      generatePlaywrightTests,
    }
  },
  { persist: true },
)
