import type { CreateSandboxExperimentInput, SandboxFixture } from '@cat-factory/contracts'
import { BUILTIN_SANDBOX_FIXTURES, toSandboxFixture } from '@cat-factory/sandbox-fixtures'
import { sandboxKindMeta } from './baselines.js'

// The Sandbox loads its builtin fixtures from the workspace `@cat-factory/sandbox-fixtures`
// package by default — that package is the single source of truth for the hand-authored,
// graded no-repo fixtures. Re-exported here so every consumer imports them (and the
// experiment-suggestion helper) from `@cat-factory/sandbox`.

export {
  BUILTIN_SANDBOX_FIXTURES,
  builtinFixturesFor,
  builtinFixture,
  toSandboxFixture,
  type SandboxFixtureDefinition,
  type SandboxFixtureDifficulty,
} from '@cat-factory/sandbox-fixtures'

/**
 * The default-loaded builtin fixtures as wire `SandboxFixture`s (the runtime seeds these
 * when a workspace has no custom fixtures yet). `now` stamps `createdAt`.
 */
export function listBuiltinFixtures(now: number): SandboxFixture[] {
  return BUILTIN_SANDBOX_FIXTURES.map((def) => toSandboxFixture(def, now))
}

/** The synthetic baseline prompt-version id for a catalog agent kind (matches `listBaselines`). */
export function baselineVersionId(agentKind: string): string {
  const meta = sandboxKindMeta(agentKind)
  return `baseline:${meta?.basePromptId ?? agentKind}`
}

export interface SuggestExperimentInput {
  /** The agent kind every cell exercises (a Sandbox catalog kind). */
  agentKind: string
  /** Model catalog ids to test (the user's selection — e.g. `anthropic:claude-opus-4-8`). */
  models: string[]
  /** Fixture ids to run against (one or more). */
  fixtureIds: string[]
  /**
   * Prompt-version ids to test. Defaults to just the shipped baseline for the agent, so the
   * suggestion answers "which model is best?" out of the box; pass candidate lineage ids to
   * also answer "does a better prompt help?".
   */
  promptVersionIds?: string[]
  /** Judge model catalog id; omit to let the API default it (latest Claude). */
  judgeModel?: string
  /** Repeats per cell (variance); defaults to 1. */
  repeats?: number
  /** Experiment name; defaults to a label derived from the agent. */
  name?: string
  /** Optional hard token budget for the whole experiment. */
  budgetTokens?: number | null
}

/**
 * Build a ready-to-create experiment for "run these selected models and prompts against
 * these selected fixtures, mapped to this selected agent". Pure: it assembles a
 * {@link CreateSandboxExperimentInput} (the matrix is the cartesian product of prompt
 * versions × models × fixtures) without dispatching anything — the caller POSTs it to the
 * experiments API. Throws on an empty model/fixture selection so a non-runnable suggestion
 * can't be created.
 */
export function suggestExperiment(input: SuggestExperimentInput): CreateSandboxExperimentInput {
  if (input.models.length === 0)
    throw new Error('suggestExperiment: at least one model is required')
  if (input.fixtureIds.length === 0)
    throw new Error('suggestExperiment: at least one fixture is required')

  const meta = sandboxKindMeta(input.agentKind)
  const promptVersionIds =
    input.promptVersionIds && input.promptVersionIds.length > 0
      ? input.promptVersionIds
      : [baselineVersionId(input.agentKind)]

  return {
    name: input.name ?? `${meta?.label ?? input.agentKind} — sandbox run`,
    agentKind: input.agentKind,
    matrix: {
      promptVersionIds,
      models: input.models,
      fixtureIds: input.fixtureIds,
    },
    ...(input.judgeModel ? { judgeModel: input.judgeModel } : {}),
    repeats: input.repeats ?? 1,
    budgetTokens: input.budgetTokens ?? null,
  }
}
