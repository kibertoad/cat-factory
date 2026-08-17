import type { SandboxFixture } from '@cat-factory/contracts'
import { SANDBOX_REPO_FIXTURE_KINDS } from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'
import { type SandboxAgentKindMeta, sandboxKindMeta } from '@cat-factory/sandbox'

// What the Sandbox will and will not run, in ONE place.
//
// There were two doors and only one of them was locked: `createExperiment` refused a container KIND
// while `launch` refused both the kind and a repo FIXTURE, each with its own hand-written message.
// So a matrix naming a repo fixture persisted as a draft that could never be launched, and the two
// copies of the container-kind wording were free to drift from the catalog's own explanation of why.
// Both doors now assert through here, and the reason itself comes off the catalog entry
// (`unsupportedReason`), which is the same string the SPA renders on the disabled option.

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
    throw new ValidationError(
      meta.unsupportedReason ?? `"${agentKind}" cannot run in the Sandbox`,
      {
        reason: 'sandbox_kind_unsupported',
      },
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
