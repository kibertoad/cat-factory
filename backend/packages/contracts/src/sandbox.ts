import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Sandbox wire contracts. The Sandbox is a parallel, opt-in surface for the
// organized testing of prompts and models: clone any shipped agent system prompt
// into a versioned, labelled *candidate*, then run an experiment matrix (prompt
// versions × models × fixtures) for one agent kind and grade every cell with a
// judge model (default Claude) plus, where a fixture supports it, an objective
// signal (a hidden test suite / a set of expected findings).
//
// The two questions it answers: "which model is best for this task?" (one prompt,
// many models) and "does a better prompt help?" (one model, many prompt versions).
//
// Models are referenced the same way the rest of the product references them — by
// model *catalog id* string (the `ModelOption.id` from `GET /models`, e.g.
// `anthropic:claude-opus-4-8`) — not a structured ModelRef; the run resolves the id
// at dispatch like any other step. Baselines are NOT persisted as rows; they are
// read live from `@cat-factory/agents`. Only candidate versions are stored.
// ---------------------------------------------------------------------------

/** Whether a prompt version is a read-only shipped baseline or a stored, editable candidate. */
export const sandboxPromptOriginSchema = v.picklist(['baseline', 'candidate'])
export type SandboxPromptOrigin = v.InferOutput<typeof sandboxPromptOriginSchema>

const labelSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40))

/**
 * One version of a system prompt under test. A `candidate` is a stored, immutable
 * row in a lineage: cloning a baseline creates version 1, and each save appends a
 * new version with `version = parent.version + 1` sharing the lineage's first id as
 * its root. `baseline` rows are never persisted — the management API synthesizes
 * them from the live shipped prompts so they always reflect current source.
 */
export const sandboxPromptVersionSchema = v.object({
  id: v.string(),
  /** The lineage this version belongs to (the id of its v1); groups versions in the UI. */
  lineageId: v.string(),
  /** The agent kind this prompt drives (`coder`, `reviewer`, `requirements-review`, …). */
  agentKind: v.string(),
  /** Human label for the lineage (defaults to the agent kind on first clone). */
  name: v.string(),
  origin: sandboxPromptOriginSchema,
  /** The system prompt text this version supplies (overrides the shipped role prompt). */
  systemText: v.string(),
  /** The shipped baseline id this lineage derives from (e.g. a `PROMPT_VERSIONS` id), if any. */
  basePromptId: v.nullable(v.string()),
  /** Monotonic version within the lineage; baselines are always 0. */
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The version this one was saved from (clone source / previous edit); null for v1. */
  parentId: v.nullable(v.string()),
  /** Freeform labels for grouping/filtering candidate versions. */
  labels: v.array(labelSchema),
  createdAt: v.number(),
  createdBy: v.nullable(v.string()),
  /** Soft-archive marker; archived versions are hidden from the default listing. */
  archivedAt: v.nullable(v.number()),
})
export type SandboxPromptVersion = v.InferOutput<typeof sandboxPromptVersionSchema>

// ---- Fixtures -------------------------------------------------------------

/**
 * The kind of starting point a fixture supplies. Inline kinds carry their whole
 * input in `payload`; repo kinds point at a seed commit in the fixture repo and the
 * agent works on an ephemeral branch off it.
 */
export const sandboxFixtureKindSchema = v.picklist([
  'requirements',
  'clarity',
  'architecture',
  'code-review',
  'repo-feature',
  'repo-bug',
])
export type SandboxFixtureKind = v.InferOutput<typeof sandboxFixtureKindSchema>

/** A pinned starting point in the dedicated fixture repo for a container-agent fixture. */
export const sandboxRepoRefSchema = v.object({
  owner: v.string(),
  name: v.string(),
  /** A tag/branch/commit naming the reproducible seed; resolved to a SHA at dispatch. */
  seedRef: v.string(),
})
export type SandboxRepoRef = v.InferOutput<typeof sandboxRepoRefSchema>

/** Fixture kinds whose starting point is a repo seed (vs. an inline payload). */
export const SANDBOX_REPO_FIXTURE_KINDS = ['repo-feature', 'repo-bug'] as const

/**
 * A fixture's shape must match its kind: repo kinds (`repo-feature`/`repo-bug`) carry a
 * `repoRef` and no inline `payload`; inline kinds carry a `payload` and no `repoRef`.
 * Enforced as a cross-field check so a contradictory fixture (e.g. a `repo-feature` with
 * a null `repoRef`, or an inline fixture with a null `payload`) can never be stored and
 * then crash the run driver when it resolves the seed/context at dispatch.
 */
const fixtureShapeMatchesKind = (input: {
  kind: SandboxFixtureKind
  payload: Record<string, unknown> | null
  repoRef: SandboxRepoRef | null
}): boolean => {
  const isRepo = (SANDBOX_REPO_FIXTURE_KINDS as readonly string[]).includes(input.kind)
  return isRepo
    ? input.repoRef !== null && input.payload === null
    : input.payload !== null && input.repoRef === null
}

const FIXTURE_SHAPE_MESSAGE =
  'Repo fixtures (repo-feature/repo-bug) require a repoRef and no payload; inline fixtures require a payload and no repoRef'

/**
 * A single thing a strong answer should surface, graded on two axes the judge and the
 * objective scorer both consume:
 * - `trickiness` (1..5): how hard the item is to spot. Catching a tricky item is a "wow"
 *   (it earns a bonus); MISSING a tricky item is not, by itself, scary.
 * - `impact` (1..5): how bad it is to miss. Missing a high-impact item harms the score
 *   the most — impact, not trickiness, drives the miss penalty.
 * The asymmetry is deliberate (see `scoreExpectations` in `@cat-factory/sandbox`).
 */
export const sandboxExpectationSchema = v.object({
  id: v.string(),
  /** The finding to look for, phrased as the judge should see it. */
  summary: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** Fuller description woven into the judge brief; defaults to empty. */
  detail: v.optional(v.string(), ''),
  /** How hard it is to spot (1..5); drives the "wow" bonus when caught. */
  trickiness: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)),
  /** How bad it is to miss (1..5); drives the miss penalty. */
  impact: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)),
  /**
   * Phrases the deterministic scorer matches (token-sequence) to decide whether the
   * candidate caught this item. Empty ⇒ the scorer falls back to matching `summary`.
   */
  matchHints: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1))), []),
})
export type SandboxExpectation = v.InferOutput<typeof sandboxExpectationSchema>

/**
 * The optional objective check a fixture declares, used alongside the LLM judge.
 * `tests` runs a hidden command against the agent's produced branch (pass/fail);
 * `findings` matches the candidate output against a set of graded expected findings
 * (each with trickiness/impact), scored asymmetrically by `scoreExpectations`.
 */
export const sandboxFixtureObjectiveSchema = v.variant('kind', [
  v.object({
    kind: v.literal('tests'),
    /** Shell command run against the produced branch; exit 0 = pass. */
    testCmd: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
  v.object({
    kind: v.literal('findings'),
    /** The genuine issues a good output should surface, each graded by trickiness/impact. */
    expectations: v.array(sandboxExpectationSchema),
  }),
])
export type SandboxFixtureObjective = v.InferOutput<typeof sandboxFixtureObjectiveSchema>

const sandboxFixtureObjectSchema = v.object({
  id: v.string(),
  kind: sandboxFixtureKindSchema,
  name: v.string(),
  /** Inline input for prompt-only fixtures (the synthesized agent run context); null for repo fixtures. */
  payload: v.nullable(v.record(v.string(), v.unknown())),
  /** Seed for container fixtures; null for inline fixtures. */
  repoRef: v.nullable(sandboxRepoRefSchema),
  /** Optional objective check; null when only the LLM judge grades this fixture. */
  objective: v.nullable(sandboxFixtureObjectiveSchema),
  /** `builtin` fixtures are seeded from code; `custom` are workspace-authored. */
  origin: v.picklist(['builtin', 'custom']),
  createdAt: v.number(),
})
export const sandboxFixtureSchema = v.pipe(
  sandboxFixtureObjectSchema,
  v.check(
    (f: v.InferOutput<typeof sandboxFixtureObjectSchema>) => fixtureShapeMatchesKind(f),
    FIXTURE_SHAPE_MESSAGE,
  ),
)
export type SandboxFixture = v.InferOutput<typeof sandboxFixtureSchema>

// ---- Experiments ----------------------------------------------------------

export const sandboxExperimentStatusSchema = v.picklist(['draft', 'running', 'done', 'failed'])
export type SandboxExperimentStatus = v.InferOutput<typeof sandboxExperimentStatusSchema>

/** The grid an experiment expands: every (prompt version × model × fixture) is one cell. */
export const sandboxMatrixSchema = v.object({
  promptVersionIds: v.array(v.string()),
  /** Model catalog ids (e.g. `anthropic:claude-opus-4-8`). */
  models: v.array(v.string()),
  fixtureIds: v.array(v.string()),
})
export type SandboxMatrix = v.InferOutput<typeof sandboxMatrixSchema>

export const sandboxExperimentSchema = v.object({
  id: v.string(),
  name: v.string(),
  /** The single agent kind every cell of this experiment exercises. */
  agentKind: v.string(),
  /** Model catalog id of the judge (defaults to the latest Claude). */
  judgeModel: v.string(),
  /** How many times each cell is run, to expose model nondeterminism (variance). */
  repeats: v.pipe(v.number(), v.integer(), v.minValue(1)),
  status: sandboxExperimentStatusSchema,
  matrix: sandboxMatrixSchema,
  /**
   * Optional token budget for the whole experiment; null = uncapped. Enforced as a soft
   * cap BETWEEN cells: once the running total reaches the budget no further cells start,
   * but the cell already in flight (its candidate + judge calls) runs to completion, so a
   * run may overshoot by up to one cell's spend.
   */
  budgetTokens: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  createdAt: v.number(),
  createdBy: v.nullable(v.string()),
})
export type SandboxExperiment = v.InferOutput<typeof sandboxExperimentSchema>

// ---- Runs (cells) ---------------------------------------------------------

export const sandboxRunStatusSchema = v.picklist(['queued', 'running', 'done', 'failed'])
export type SandboxRunStatus = v.InferOutput<typeof sandboxRunStatusSchema>

export const sandboxTokenUsageSchema = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
})
export type SandboxTokenUsage = v.InferOutput<typeof sandboxTokenUsageSchema>

export const sandboxRunSchema = v.object({
  id: v.string(),
  experimentId: v.string(),
  promptVersionId: v.string(),
  /** The exact model catalog id this cell ran (frozen from the matrix). */
  model: v.string(),
  fixtureId: v.string(),
  /** 0-based repeat index within the cell. */
  repeatIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
  status: sandboxRunStatusSchema,
  /** The agent's captured output (prose, JSON, or a rendered diff). */
  outputText: v.nullable(v.string()),
  usage: v.nullable(sandboxTokenUsageSchema),
  latencyMs: v.nullable(v.number()),
  /** Ephemeral work branch for container cells; null for inline cells. */
  branch: v.nullable(v.string()),
  prUrl: v.nullable(v.string()),
  /** Captured diff for container cells (truncated by the harness). */
  diff: v.nullable(v.string()),
  error: v.nullable(v.string()),
  /** Resolved fixture seed commit, pinned at dispatch for reproducibility. */
  seedSha: v.nullable(v.string()),
  /** Frozen `name@vN` label of the prompt version this cell ran. */
  promptLabel: v.string(),
  startedAt: v.nullable(v.number()),
  finishedAt: v.nullable(v.number()),
})
export type SandboxRun = v.InferOutput<typeof sandboxRunSchema>

// ---- Grades ---------------------------------------------------------------

/** One rubric dimension's judged score (1–5) with the judge's rationale. */
export const sandboxGradeDimensionSchema = v.object({
  key: v.string(),
  score: v.pipe(v.number(), v.minValue(1), v.maxValue(5)),
  rationale: v.string(),
})
export type SandboxGradeDimension = v.InferOutput<typeof sandboxGradeDimensionSchema>

/**
 * The objective check's outcome, recorded alongside (never blended into) the rubric grade.
 * For `findings`, `pass` means no high-impact expectation was missed, and the asymmetric
 * breakdown is carried in the nullable fields (see `scoreExpectations`): `impactRecall`
 * (1 − impact-weighted miss rate), `wowBonus` (trickiness-weighted catch rate over the
 * tricky items), `caught`/`total` counts, and the ids of any missed high-impact items.
 * `tests` results leave the findings-only fields null.
 */
export const sandboxObjectiveResultSchema = v.object({
  kind: v.picklist(['tests', 'findings']),
  pass: v.boolean(),
  detail: v.string(),
  /** Impact-weighted recall in [0,1] (findings only; null for tests). */
  impactRecall: v.nullable(v.number()),
  /** Trickiness-weighted "wow" bonus in [0,1] (findings only; null for tests). */
  wowBonus: v.nullable(v.number()),
  /** Expectations the candidate caught (findings only; null for tests). */
  caught: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  /** Total expectations declared (findings only; null for tests). */
  total: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
  /** Ids of missed expectations with impact ≥ 4 (findings only; null for tests). */
  missedHighImpact: v.nullable(v.array(v.string())),
})
export type SandboxObjectiveResult = v.InferOutput<typeof sandboxObjectiveResultSchema>

export const sandboxGradeSchema = v.object({
  id: v.string(),
  runId: v.string(),
  /** Model catalog id of the judge that produced this grade. */
  judgeModel: v.string(),
  scores: v.array(sandboxGradeDimensionSchema),
  /** Weighted mean of the dimension scores using the task rubric weights. */
  weightedTotal: v.number(),
  /** Objective signal when the fixture declared one; null otherwise. */
  objective: v.nullable(sandboxObjectiveResultSchema),
  createdAt: v.number(),
})
export type SandboxGrade = v.InferOutput<typeof sandboxGradeSchema>

// ---- Request bodies -------------------------------------------------------

/** Clone a shipped baseline (or another version) into a fresh candidate lineage at v1. */
export const cloneSandboxPromptSchema = v.object({
  agentKind: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** The shipped baseline id to seed the text from (e.g. a `PROMPT_VERSIONS` id). */
  basePromptId: v.nullable(v.string()),
  /** Lineage name; defaults to the agent kind when omitted. */
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80))),
  labels: v.optional(v.array(labelSchema), []),
})
export type CloneSandboxPromptInput = v.InferOutput<typeof cloneSandboxPromptSchema>

/** Save a new version onto an existing lineage (append-only edit). */
export const saveSandboxVersionSchema = v.object({
  /** The version id this edit is based on (its lineage + version+1 are derived). */
  parentId: v.pipe(v.string(), v.minLength(1)),
  systemText: v.pipe(v.string(), v.minLength(1)),
  labels: v.optional(v.array(labelSchema), []),
})
export type SaveSandboxVersionInput = v.InferOutput<typeof saveSandboxVersionSchema>

/** Replace the labels on a candidate version. */
export const setSandboxLabelsSchema = v.object({
  labels: v.array(labelSchema),
})
export type SetSandboxLabelsInput = v.InferOutput<typeof setSandboxLabelsSchema>

/** Create a custom fixture in a workspace. */
const createSandboxFixtureObjectSchema = v.object({
  kind: sandboxFixtureKindSchema,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  payload: v.optional(v.nullable(v.record(v.string(), v.unknown())), null),
  repoRef: v.optional(v.nullable(sandboxRepoRefSchema), null),
  objective: v.optional(v.nullable(sandboxFixtureObjectiveSchema), null),
})
export const createSandboxFixtureSchema = v.pipe(
  createSandboxFixtureObjectSchema,
  v.check(
    (f: v.InferOutput<typeof createSandboxFixtureObjectSchema>) => fixtureShapeMatchesKind(f),
    FIXTURE_SHAPE_MESSAGE,
  ),
)
export type CreateSandboxFixtureInput = v.InferOutput<typeof createSandboxFixtureSchema>

/** Create an experiment (status `draft`); launching it expands the matrix into runs. */
export const createSandboxExperimentSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  agentKind: v.pipe(v.string(), v.trim(), v.minLength(1)),
  matrix: sandboxMatrixSchema,
  judgeModel: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  repeats: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)), 1),
  budgetTokens: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))), null),
})
export type CreateSandboxExperimentInput = v.InferOutput<typeof createSandboxExperimentSchema>
