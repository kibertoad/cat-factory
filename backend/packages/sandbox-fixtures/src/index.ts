// @cat-factory/sandbox-fixtures — hand-authored, standardized, graded no-repo fixtures for
// the Sandbox. These are the inline (text-only) agent inputs that need NO repository
// checkout: requirements review, bug-report (clarity) review, recommended answers, task
// estimation, code review (single-snippet and repo-scale) and architecture-proposal review, each
// with a set of expected findings graded by trickiness (how hard to spot; catching it is a "wow")
// and impact (how bad to miss). Depends only on @cat-factory/contracts so the published
// @cat-factory/sandbox can load it via workspace:*.
//
// Each payload is the EXACT context shape the agent's production caller consumes, so the run-driver
// can render it through that caller's own prompt builder rather than an approximation
// (`orchestration/modules/sandbox/sandbox-input.ts`); `sandbox-fixture-payloads.test.ts` pins the
// payloads against those types. A repo-SCALE change arrives on `injectedContextFiles`, the
// production seam for delivering repository material to a caller with no filesystem.

export {
  type SandboxFixtureDefinition,
  type SandboxFixtureDifficulty,
  type SandboxExpectation,
  type SandboxFixtureKind,
} from './types.js'

export { exp } from './expectation.js'

export {
  BUILTIN_SANDBOX_FIXTURES,
  builtinFixturesFor,
  builtinFixture,
  toSandboxFixture,
} from './registry.js'

export { REQUIREMENTS_FIXTURES } from './fixtures/requirements.js'
export { CLARITY_FIXTURES } from './fixtures/clarity.js'
export { ANSWER_RECOMMENDATION_FIXTURES } from './fixtures/answer-recommendation.js'
export { ESTIMATION_FIXTURES } from './fixtures/estimation.js'
export { CODE_REVIEW_FIXTURES } from './fixtures/code-review.js'
export { CODE_REVIEW_REPO_FIXTURES } from './fixtures/code-review-repo.js'
export { ARCHITECTURE_FIXTURES } from './fixtures/architecture.js'
