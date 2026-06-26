// Sandbox (the parallel prompt/model testing surface) wire shapes, hand-mirrored from
// `@cat-factory/contracts` (sandbox.ts) so a backend payload drops straight into the
// store. Clone a shipped agent prompt into a versioned candidate, run an experiment
// matrix (prompt versions × models × fixtures) for one agent kind, and grade every cell
// with a judge model plus (where a fixture supports it) an objective findings score.

export type SandboxPromptOrigin = 'baseline' | 'candidate'

export interface SandboxPromptVersion {
  id: string
  lineageId: string
  agentKind: string
  name: string
  origin: SandboxPromptOrigin
  systemText: string
  basePromptId: string | null
  version: number
  parentId: string | null
  labels: string[]
  createdAt: number
  createdBy: string | null
  archivedAt: number | null
}

export type SandboxFixtureKind =
  | 'requirements'
  | 'clarity'
  | 'architecture'
  | 'code-review'
  | 'repo-feature'
  | 'repo-bug'

export interface SandboxExpectation {
  id: string
  summary: string
  detail: string
  trickiness: number
  impact: number
  matchHints: string[]
}

export type SandboxFixtureObjective =
  | { kind: 'tests'; testCmd: string }
  | { kind: 'findings'; expectations: SandboxExpectation[] }

export interface SandboxFixture {
  id: string
  kind: SandboxFixtureKind
  name: string
  payload: Record<string, unknown> | null
  repoRef: { owner: string; name: string; seedRef: string } | null
  objective: SandboxFixtureObjective | null
  origin: 'builtin' | 'custom'
  createdAt: number
}

export type SandboxExperimentStatus = 'draft' | 'running' | 'done' | 'failed'

export interface SandboxMatrix {
  promptVersionIds: string[]
  models: string[]
  fixtureIds: string[]
}

export interface SandboxExperiment {
  id: string
  name: string
  agentKind: string
  judgeModel: string
  repeats: number
  status: SandboxExperimentStatus
  matrix: SandboxMatrix
  budgetTokens: number | null
  createdAt: number
  createdBy: string | null
}

export type SandboxRunStatus = 'queued' | 'running' | 'done' | 'failed'

export interface SandboxTokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface SandboxRun {
  id: string
  experimentId: string
  promptVersionId: string
  model: string
  fixtureId: string
  repeatIndex: number
  status: SandboxRunStatus
  outputText: string | null
  usage: SandboxTokenUsage | null
  latencyMs: number | null
  branch: string | null
  prUrl: string | null
  diff: string | null
  error: string | null
  seedSha: string | null
  promptLabel: string
  startedAt: number | null
  finishedAt: number | null
}

export interface SandboxGradeDimension {
  key: string
  score: number
  rationale: string
}

export interface SandboxObjectiveResult {
  kind: 'tests' | 'findings'
  pass: boolean
  detail: string
  impactRecall: number | null
  wowBonus: number | null
  caught: number | null
  total: number | null
  missedHighImpact: string[] | null
}

export interface SandboxGrade {
  id: string
  runId: string
  judgeModel: string
  scores: SandboxGradeDimension[]
  weightedTotal: number
  objective: SandboxObjectiveResult | null
  createdAt: number
}

/** The Sandbox catalog entry for a testable agent kind (from the overview). */
export interface SandboxAgentKindMeta {
  agentKind: string
  label: string
  bucket: 'inline' | 'container'
  rubric: 'requirement-review' | 'code-review' | 'implementation'
  /** Fixture kinds this agent is exercised against (the UI filters the library by these). */
  fixtureKinds: SandboxFixtureKind[]
  basePromptId: string | null
}

/** The composite the management surface loads on open (`GET /sandbox/overview`). */
export interface SandboxOverview {
  agentKinds: SandboxAgentKindMeta[]
  prompts: SandboxPromptVersion[]
  fixtures: SandboxFixture[]
  experiments: SandboxExperiment[]
  /** The matrix cell cap (the backend cost guard), so the builder gates on the same limit. */
  maxCells: number
}

/** An experiment with its result grid (`GET /sandbox/experiments/:id`, also from launch). */
export interface SandboxExperimentDetail {
  experiment: SandboxExperiment
  runs: SandboxRun[]
  grades: SandboxGrade[]
}

// ---- request bodies --------------------------------------------------------

export interface CloneSandboxPromptInput {
  agentKind: string
  basePromptId: string | null
  name?: string
  labels?: string[]
}

export interface SaveSandboxVersionInput {
  parentId: string
  systemText: string
  labels?: string[]
}

export interface CreateSandboxExperimentInput {
  name: string
  agentKind: string
  matrix: SandboxMatrix
  judgeModel?: string
  repeats?: number
  budgetTokens?: number | null
}
