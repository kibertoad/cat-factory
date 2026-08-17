// Sandbox (the parallel prompt/model testing surface) wire shapes. Clone a shipped
// agent prompt into a versioned candidate, run an experiment matrix (prompt versions ×
// models × fixtures) for one agent kind, and grade every cell with a judge model plus
// (where a fixture supports it) an objective findings score.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).
// The overview / agent-kind-meta / experiment-detail composites have no exported
// contract type (the routes model them inline), so they stay frontend-only below.
// `bucket` and `sandboxRun` reuse the contract's picklist types (the builder branches on
// `sandboxRun`, so a widened `string` there would let a typo compile); `rubric` stays the
// contract's looser `string`, since nothing here branches on it.

export type {
  SandboxAgentBucket,
  SandboxRunMode,
  SandboxPromptOrigin,
  SandboxPromptVersion,
  SandboxFixtureKind,
  SandboxExpectation,
  SandboxFixtureObjective,
  SandboxFixture,
  SandboxExperimentStatus,
  SandboxMatrix,
  SandboxExperiment,
  SandboxRunStatus,
  SandboxTokenUsage,
  SandboxRun,
  SandboxGradeDimension,
  SandboxObjectiveResult,
  SandboxGrade,
  CloneSandboxPromptInput,
  SaveSandboxVersionInput,
  CreateSandboxExperimentInput,
} from '@cat-factory/contracts'

import type {
  SandboxAgentBucket,
  SandboxExperiment,
  SandboxFixture,
  SandboxFixtureKind,
  SandboxGrade,
  SandboxPromptVersion,
  SandboxRun,
  SandboxRunMode,
} from '@cat-factory/contracts'

/** The Sandbox catalog entry for a testable agent kind (from the overview). Frontend-only. */
export interface SandboxAgentKindMeta {
  agentKind: string
  label: string
  /** How PRODUCTION dispatches the kind (an inline call, or a container with a checkout). */
  bucket: SandboxAgentBucket
  /**
   * How the SANDBOX runs a cell for it. `unsupported` ⇒ the builder must not offer it: creating an
   * experiment for such a kind is refused server-side, so an enabled option would only ever produce
   * a 400 on a surface that suggested it.
   */
  sandboxRun: SandboxRunMode
  /** Why the Sandbox cannot run this kind, straight from the catalog; null when it can. */
  unsupportedReason: string | null
  rubric: string
  /** Fixture kinds this agent is exercised against (the UI filters the library by these). */
  fixtureKinds: SandboxFixtureKind[]
  basePromptId: string | null
}

/** The composite the management surface loads on open (`GET /sandbox/overview`). Frontend-only. */
export interface SandboxOverview {
  agentKinds: SandboxAgentKindMeta[]
  prompts: SandboxPromptVersion[]
  fixtures: SandboxFixture[]
  experiments: SandboxExperiment[]
  /** The matrix cell cap (the backend cost guard), so the builder gates on the same limit. */
  maxCells: number
}

/** An experiment with its result grid (`GET /sandbox/experiments/:id`, also from launch). Frontend-only. */
export interface SandboxExperimentDetail {
  experiment: SandboxExperiment
  runs: SandboxRun[]
  grades: SandboxGrade[]
}
