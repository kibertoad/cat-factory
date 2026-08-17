import type { SandboxFixture, SandboxUnsupportedReason } from '@cat-factory/contracts'
import { SANDBOX_REPO_FIXTURE_KINDS } from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'
import { type SandboxAgentKindMeta, sandboxKindMeta } from '@cat-factory/sandbox'

// What the Sandbox will and will not run, in ONE place.
//
// There were two doors and only one of them was locked: `createExperiment` refused a container KIND
// while `launch` refused both the kind and a repo FIXTURE, each with its own hand-written message.
// So a matrix naming a repo fixture persisted as a draft that could never be launched, and the two
// copies of the container-kind wording were free to drift from the catalog's own explanation of why.
// Both doors now assert through here, and WHICH refusal applies comes off the catalog entry
// (`unsupportedReason`), the same value the SPA maps to its translated note.

/**
 * The API-facing sentence for each refusal code, exhaustive over the vocabulary so a new member
 * fails to compile until it has one.
 *
 * English on purpose: this is the message on a `ValidationError`, read by whoever called the
 * endpoint, and it carries `details.reason` for a client that wants to say it differently. The
 * SPA never renders it (it maps the CODE to a locale key), which is what keeps the catalog free of
 * prose no locale can reach.
 */
const UNSUPPORTED_MESSAGES: Record<SandboxUnsupportedReason, string> = {
  'container-run-required':
    'This agent’s deliverable is a pushed commit, so grading it needs a real container run ' +
    'against a seed repository. Register a repo fixture pointing at a repository this deployment ' +
    'owns once container cells land; an inline cell can only grade text.',
}

/**
 * Resolve a Sandbox-testable kind, refusing one the catalog does not know or cannot run.
 *
 * Refused as early as the caller can manage: at CREATE, so a draft nobody can launch is never
 * stored, and again at LAUNCH, because a catalog entry can stop being runnable between the two (a
 * kind whose production surface changed) and a stored draft would otherwise dispatch under a
 * composition that no longer matches it.
 */
export function assertSandboxRunnable(agentKind: string): SandboxAgentKindMeta {
  const meta = sandboxKindMeta(agentKind)
  if (!meta) {
    throw new ValidationError(`"${agentKind}" is not a Sandbox-testable agent kind`, {
      reason: 'sandbox_kind_unknown',
    })
  }
  if (meta.sandboxRun === 'unsupported') {
    const reason = meta.unsupportedReason
    throw new ValidationError(
      reason ? UNSUPPORTED_MESSAGES[reason] : `"${agentKind}" cannot run in the Sandbox`,
      { reason: 'sandbox_kind_unsupported' },
    )
  }
  return meta
}

/**
 * Refuse a fixture whose starting point is a repository seed.
 *
 * The run-driver is inline-only: it has no container, no clone and no branch to push, so a
 * `repo-feature` / `repo-bug` fixture has nothing to run against. The message names the route rather
 * than saying "not yet supported", because the two ways to get there are different work and a reader
 * deciding whether to wait needs to know which one is missing (see
 * `docs/initiatives/sandbox-coverage-expansion.md`).
 */
export function assertSandboxRunnableFixture(fixture: Pick<SandboxFixture, 'kind' | 'name'>): void {
  if (!(SANDBOX_REPO_FIXTURE_KINDS as readonly string[]).includes(fixture.kind)) return
  throw new ValidationError(
    `Fixture "${fixture.name}" starts from a repository seed, and Sandbox cells run inline with no ` +
      'checkout. Use an inline fixture, or wait for container cells (which need a seed repository ' +
      'this deployment owns).',
    { reason: 'sandbox_fixture_needs_checkout' },
  )
}

/**
 * Refuse a fixture the chosen agent kind does not claim.
 *
 * The catalog entry's `fixtureKinds` is what the library filter offers, but the FILTER is the SPA's
 * and the API is not the SPA's only caller. Without this, `POST /sandbox/experiments` accepted a
 * `requirements` fixture under `task-estimator`: the estimator's system prompt went out, the
 * requirements payload rendered through the estimator's builder, and the cell was graded against
 * the `estimation` rubric using the requirements fixture's expectations. Every layer behaved
 * correctly and the resulting score meant nothing.
 *
 * The catalog already guarantees no two kinds claim the same fixture kind (`baselines.test.ts`), so
 * a fixture belongs to at most one agent and this is a total answer rather than a heuristic.
 */
export function assertSandboxFixtureMatchesKind(
  fixture: Pick<SandboxFixture, 'kind' | 'name'>,
  meta: SandboxAgentKindMeta,
): void {
  if ((meta.fixtureKinds as readonly string[]).includes(fixture.kind)) return
  throw new ValidationError(
    `Fixture "${fixture.name}" is a "${fixture.kind}" fixture, which "${meta.agentKind}" is not ` +
      `exercised against (it takes: ${meta.fixtureKinds.join(', ')}). Grading it here would score ` +
      "one agent's task on another's rubric.",
    { reason: 'sandbox_fixture_kind_mismatch' },
  )
}
