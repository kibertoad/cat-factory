/* eslint-disable unicorn/no-thenable -- `then` is the Gherkin clause name on plain
   scenario data objects (a string[]), never a thenable callback; these objects
   are never awaited. */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { uid } from '~/utils/catalog'
import type { AcceptanceScenario, Block } from '~/types/domain'

/** Context the acceptance agent draws on when drafting scenarios for a feature. */
export interface ScenarioGenerationContext {
  /** The block's free-text intent. */
  description?: string
  /** Titles/excerpts of linked requirement docs (PRDs), for traceable scenarios. */
  requirements?: string[]
}

/** Normalise a feature/title into a comparable key (case- and space-insensitive). */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Draft the standard set of acceptance scenarios for a feature: the happy path,
 * an error path and an input-validation path. This mirrors what the `acceptance`
 * agent does from requirements — deterministic here so the prototype has
 * something concrete and editable to show. The feature name and any linked
 * requirements are folded into the Given/When/Then so the output is specific.
 */
function draftScenarios(
  feature: string,
  context: ScenarioGenerationContext = {},
): Omit<AcceptanceScenario, 'id' | 'createdAt'>[] {
  const name = feature.trim()
  const reqGiven = context.requirements?.length
    ? [`the requirements for "${name}" (${context.requirements.join('; ')})`]
    : []
  const base = ['a user on the application', ...reqGiven]

  return [
    {
      feature: name,
      title: `${name}: happy path`,
      given: base,
      when: [`the user completes the "${name}" flow with valid input`],
      then: [`the action succeeds`, `the expected result for "${name}" is shown`],
      status: 'draft',
      source: 'generated',
      hasPlaywrightTest: false,
    },
    {
      feature: name,
      title: `${name}: invalid input is rejected`,
      given: base,
      when: [`the user attempts the "${name}" flow with invalid input`],
      then: [`the action is rejected`, `a clear error message is shown`],
      status: 'draft',
      source: 'generated',
      hasPlaywrightTest: false,
    },
    {
      feature: name,
      title: `${name}: required fields are validated`,
      given: base,
      when: [`the user submits the "${name}" flow with required fields missing`],
      then: [`submission is blocked`, `each missing field is flagged`],
      status: 'draft',
      source: 'generated',
      hasPlaywrightTest: false,
    },
  ]
}

/**
 * The acceptance-scenario catalog. Feature-scoped Given/When/Then scenarios that
 * the `acceptance` agent drafts from requirements and the `playwright` agent
 * turns into e2e tests. Authored and refined client-side (persisted locally),
 * this is the data the feature's scenario viewer renders.
 */
export const useScenariosStore = defineStore(
  'scenarios',
  () => {
    const scenarios = ref<AcceptanceScenario[]>([])

    /** Scenarios for a single feature, oldest first. */
    function scenariosForFeature(feature: string): AcceptanceScenario[] {
      const key = normalize(feature)
      return scenarios.value
        .filter((s) => normalize(s.feature) === key)
        .sort((a, b) => a.createdAt - b.createdAt)
    }

    /** Scenarios across all of a block's features (the "current set" for a task). */
    function scenariosForBlock(block: Pick<Block, 'features'>): AcceptanceScenario[] {
      const features = (block.features ?? []).map(normalize)
      if (!features.length) return []
      const set = new Set(features)
      return scenarios.value
        .filter((s) => set.has(normalize(s.feature)))
        .sort((a, b) => a.createdAt - b.createdAt)
    }

    /** True when a feature already has at least one scenario. */
    function hasScenarios(feature: string): boolean {
      const key = normalize(feature)
      return scenarios.value.some((s) => normalize(s.feature) === key)
    }

    function addScenario(input: {
      feature: string
      title?: string
      given?: string[]
      when?: string[]
      then?: string[]
      source?: AcceptanceScenario['source']
    }): AcceptanceScenario {
      const scenario: AcceptanceScenario = {
        id: uid('scn'),
        feature: input.feature.trim(),
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
     * Draft scenarios for a feature from its requirements. Additive: titles that
     * already exist for the feature are skipped, so re-running only fills gaps and
     * never clobbers edits. Returns the scenarios actually created.
     */
    function generateForFeature(
      feature: string,
      context: ScenarioGenerationContext = {},
    ): AcceptanceScenario[] {
      const existing = new Set(scenariosForFeature(feature).map((s) => normalize(s.title)))
      const created: AcceptanceScenario[] = []
      for (const draft of draftScenarios(feature, context)) {
        if (existing.has(normalize(draft.title))) continue
        created.push(addScenario({ ...draft, source: 'generated' }))
      }
      return created
    }

    /**
     * "Generate Playwright tests" for a feature. Mirrors the `playwright` agent's
     * idempotent contract: only scenarios that don't yet have a test get one, so
     * existing committed tests are never regenerated. Returns the scenarios for
     * which a new test was created.
     */
    function generatePlaywrightTests(feature: string): AcceptanceScenario[] {
      const created: AcceptanceScenario[] = []
      for (const scenario of scenariosForFeature(feature)) {
        if (scenario.hasPlaywrightTest) continue
        scenario.hasPlaywrightTest = true
        created.push(scenario)
      }
      return created
    }

    /** Count of scenarios still missing a Playwright test, for a feature. */
    const untested = computed(
      () => (feature: string) =>
        scenariosForFeature(feature).filter((s) => !s.hasPlaywrightTest).length,
    )

    return {
      scenarios,
      scenariosForFeature,
      scenariosForBlock,
      hasScenarios,
      untested,
      addScenario,
      updateScenario,
      removeScenario,
      generateForFeature,
      generatePlaywrightTests,
    }
  },
  { persist: true },
)
