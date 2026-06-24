// @cat-factory/sandbox-fixtures — hand-authored, standardized, graded no-repo fixtures for
// the Sandbox. These are the inline (text-only) agent inputs that need NO repository
// checkout — requirements review, bug-report (clarity) review, code review, and
// architecture-proposal review — each with a set of expected findings graded by trickiness
// (how hard to spot; catching it is a "wow") and impact (how bad to miss). Depends only on
// @cat-factory/contracts so the published @cat-factory/sandbox can load it via workspace:*.

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
export { CODE_REVIEW_FIXTURES } from './fixtures/code-review.js'
export { ARCHITECTURE_FIXTURES } from './fixtures/architecture.js'
