import { type SandboxFixture, sandboxFixtureSchema } from '@cat-factory/contracts'
import * as v from 'valibot'
import { ANSWER_RECOMMENDATION_FIXTURES } from './fixtures/answer-recommendation.js'
import { ARCHITECTURE_FIXTURES } from './fixtures/architecture.js'
import { CLARITY_FIXTURES } from './fixtures/clarity.js'
import { CODE_REVIEW_FIXTURES } from './fixtures/code-review.js'
import { CODE_REVIEW_REPO_FIXTURES } from './fixtures/code-review-repo.js'
import { ESTIMATION_FIXTURES } from './fixtures/estimation.js'
import { REQUIREMENTS_FIXTURES } from './fixtures/requirements.js'
import type { SandboxFixtureDefinition } from './types.js'

/**
 * Every builtin, no-repo Sandbox fixture, hand-authored and committed for reproducibility.
 * Ordered by agent then difficulty (simple → complex) for stable display.
 */
export const BUILTIN_SANDBOX_FIXTURES: readonly SandboxFixtureDefinition[] = [
  ...REQUIREMENTS_FIXTURES,
  ...CLARITY_FIXTURES,
  ...ANSWER_RECOMMENDATION_FIXTURES,
  ...ESTIMATION_FIXTURES,
  ...CODE_REVIEW_FIXTURES,
  ...CODE_REVIEW_REPO_FIXTURES,
  ...ARCHITECTURE_FIXTURES,
]

/** The builtin fixtures authored for a given agent kind. */
export function builtinFixturesFor(agentKind: string): SandboxFixtureDefinition[] {
  return BUILTIN_SANDBOX_FIXTURES.filter((f) => f.agentKind === agentKind)
}

/** A builtin fixture by id, or undefined. */
export function builtinFixture(id: string): SandboxFixtureDefinition | undefined {
  return BUILTIN_SANDBOX_FIXTURES.find((f) => f.id === id)
}

/**
 * Project an authoring {@link SandboxFixtureDefinition} into the wire `SandboxFixture` the
 * Sandbox stores/serves: an inline `builtin` fixture whose objective is the graded
 * `findings` set. Validates against the contract schema so a malformed fixture fails loudly
 * at load (e.g. an inline payload missing, or an expectation out of the 1..5 range).
 */
export function toSandboxFixture(def: SandboxFixtureDefinition, now: number): SandboxFixture {
  return v.parse(sandboxFixtureSchema, {
    id: def.id,
    kind: def.kind,
    name: def.name,
    payload: def.payload,
    repoRef: null,
    objective: { kind: 'findings', expectations: def.expectations },
    origin: 'builtin',
    createdAt: now,
  })
}
