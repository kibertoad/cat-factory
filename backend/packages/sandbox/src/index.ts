// @cat-factory/sandbox — the parallel prompt/model testing surface. This package is
// deliberately isolated: it depends on kernel (ports), contracts (wire types) and
// agents (baseline prompts), and nothing in the core product depends on it, so the
// whole feature can be lifted out later. This entry re-exports the pure domain logic;
// the run driver + judge service (which consume the executor seams) build on top.

export {
  type SandboxTaskType,
  type Rubric,
  type RubricDimension,
  SANDBOX_TASK_TYPES,
  rubricFor,
  weightedTotal,
} from './rubrics.js'

export {
  type ExpectationScore,
  HIGH_IMPACT_THRESHOLD,
  TRICKY_THRESHOLD,
  scoreExpectations,
  renderExpectationBrief,
} from './expectations.js'

export {
  type SandboxAgentBucket,
  type SandboxAgentKindMeta,
  type SandboxRunMode,
  SANDBOX_AGENT_KINDS,
  sandboxKindMeta,
  statesMissingCheckout,
  baselinePromptText,
  listBaselines,
} from './baselines.js'

export {
  type NewVersionFields,
  firstVersionFromBaseline,
  nextVersion,
  versionLabel,
  filterByLabels,
} from './promptVersions.logic.js'

export {
  workspacePromptVersionId,
  workspacePromptLineageId,
  parseWorkspacePromptVersionId,
  workspacePromptVersions,
  sandboxPromptKinds,
} from './workspacePrompts.js'

export { type ExpandDeps, cellCount, expandMatrix, isRunnableMatrix } from './matrix.logic.js'

export {
  type SuggestExperimentInput,
  type SandboxFixtureDefinition,
  type SandboxFixtureDifficulty,
  BUILTIN_SANDBOX_FIXTURES,
  builtinFixturesFor,
  builtinFixture,
  toSandboxFixture,
  listBuiltinFixtures,
  baselineVersionId,
  suggestExperiment,
} from './fixtures.js'
