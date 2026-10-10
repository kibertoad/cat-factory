// The JUDGE seam, wired for e2e: a per-workspace deterministic verdict producer, plus the
// shipped example judge registered on the app-owned registry.
//
// Judges are the fourth step-taxonomy bucket (`docs/initiatives/judge-registry.md`): a step whose
// LLM scores the work against a rubric, which the engine compares to the task's threshold and
// then disposes — advance, bounce the producer for rework, park for a human, or fail. Two things
// have to be true before any of that is reachable from a browser:
//
//   1. A judge must be REGISTERED. `defaultJudgeRegistry()` ships EMPTY, and an unregistered
//      kind is not a judge at all, so the e2e backend registers one through the same public seam
//      a deployment uses. It registers the SHIPPED example (`@cat-factory/example-custom-agent`'s
//      `scope-adherence`), not a lookalike, so this suite covers the reference implementation the
//      docs point deployments at — including its own valibot verdict parser.
//   2. An ASSESSOR must be wired, and `enabled === false` is a pass-through. The engine's default
//      assessor is an inline LLM call, which the keyless e2e backend cannot make, so the verdict
//      comes from the per-workspace script below (the conformance suite's `fakeAssessor`, made
//      workspace-scoped the way `E2eGateProviders` makes the gate probes workspace-scoped).
//
// Registered judges reach the SPA through the workspace-capability manifest with
// `presentation.resultView: 'judge'` (see `WorkspaceController.snapshotCustomAgentKinds`), so the
// judge window opens on a parked step with no frontend wiring at all — which is exactly what
// `judge-gate.spec.ts` drives.
import { DEFAULT_JUDGE_MIN_SCORE } from '@cat-factory/contracts'
import { registerExampleScopeJudge } from '@cat-factory/example-custom-agent'
import type { buildNodeContainer } from '@cat-factory/node-server'
import type { FakeProfileRegistry, WorkspaceScopedFakes } from './fakeProfile.ts'

// Derived from the container's `overrides` contract, so this test-only package needs no direct
// `@cat-factory/kernel` dependency — the same derivation `fakeInlineModel.ts` uses.
type Overrides = NonNullable<Parameters<typeof buildNodeContainer>[0]['overrides']>
type JudgeAssessor = NonNullable<Overrides['judgeAssessor']>
type JudgeSubject = Parameters<JudgeAssessor['assess']>[0]

/** The default script: a passing verdict, so a workspace that places no judge step is inert. */
const PASSING = [1]

/**
 * A deterministic {@link JudgeAssessor} that replays each workspace's `judgeScores` queue (last
 * entry repeats), returning findings only on a failing score — the shape the engine hands the
 * producer as its rework brief on a bounce, and the window renders as the verdict's findings.
 *
 * `enabled` is a flat `true`: it answers "is an assessor wired at all", which for this backend it
 * is. Per-workspace behaviour rides the SCRIPT instead, because a judge is only ever consulted by
 * a pipeline that places one, so the default passing verdict is unreachable for every spec that
 * does not.
 *
 * The per-workspace round counter is what makes a bounce loop assertable (`[0.4, 0.9]` = fail then
 * pass), so it is keyed by workspace and reset by a profile write, exactly like the gate providers'
 * verdict sequences.
 *
 * That key is the WORKSPACE, which is the grain to know before writing a spec against it: every
 * judge assessment in a workspace draws from the one queue, so two concurrent runs (or two judge
 * steps in one pipeline) interleave, and a retried assessment consumes an entry. A spec that needs
 * a specific verdict per round therefore drives ONE run per workspace, and does not read the
 * ORDER of the queue as evidence of a bounce: `judge-gate.spec.ts` asserts the bounce on the
 * round history the engine itself recorded.
 */
export class E2eJudgeAssessor implements WorkspaceScopedFakes {
  private readonly rounds = new Map<string, number>()
  private readonly registry: FakeProfileRegistry
  readonly enabled = true

  // A plain field + body assignment, NOT a parameter property: the e2e backend runs under Node
  // type-stripping, whose strip-only mode rejects those.
  constructor(registry: FakeProfileRegistry) {
    this.registry = registry
    registry.register(this)
  }

  resetWorkspace(workspaceId: string): void {
    this.rounds.delete(workspaceId)
  }

  async assess(subject: JudgeSubject): Promise<{ verdict: unknown; model: string }> {
    const workspaceId = subject.workspaceId
    const scores = this.registry.get(workspaceId)?.judgeScores ?? PASSING
    const round = this.rounds.get(workspaceId) ?? 0
    this.rounds.set(workspaceId, round + 1)
    const score = scores[Math.min(round, scores.length - 1)] ?? 1
    return { verdict: verdictFor(score), model: 'fake:judge' }
  }
}

/**
 * The raw verdict for one score, in the canonical `{ score, summary, findings }` shape the
 * example judge's schema extends. Returned RAW (not parsed): the engine parses it with the
 * registration's own parser, which is half of what registering the real example covers.
 *
 * Findings ride a FAILING verdict only, and "failing" is the engine's own bar
 * ({@link DEFAULT_JUDGE_MIN_SCORE}, what the default preset gives every spec here) rather than a
 * literal: a verdict that CLEARED the rubric but still complains about the work is a thing no real
 * assessor produces, and a spec asserting on the findings of a passing round would be asserting on
 * a fake's quirk. Derived rather than restated, so raising the default bar cannot leave this behind.
 * The one case it does not track is a task on a preset that overrides `judgeMinScore`; no spec does,
 * and one that did would script its scores against its own preset anyway.
 */
export function verdictFor(score: number): {
  score: number
  summary: string
  findings: { title: string; detail: string; severity: 'low' | 'medium' | 'high' | 'critical' }[]
} {
  return {
    score,
    summary: `Scope adherence scored ${score.toFixed(2)} by the e2e fake assessor.`,
    findings:
      score < DEFAULT_JUDGE_MIN_SCORE
        ? [
            {
              title: 'Out-of-scope change',
              detail: 'The diff renames a helper in a module the task never mentioned.',
              severity: 'high',
            },
          ]
        : [],
  }
}

/**
 * Register the example `scope-adherence` judge on the container's app-owned registry.
 *
 * Called AFTER `buildNodeContainer` returns rather than through its `judgeRegistry` option: the
 * engine reads the registry lazily (per evaluation) and the SPA reads it per request, so
 * registering on the built container's own instance is enough — and it keeps this package free of
 * the `@cat-factory/kernel` dependency a `defaultJudgeRegistry()` call would need.
 */
export function registerE2eJudge(container: ReturnType<typeof buildNodeContainer>): void {
  registerExampleScopeJudge(container.judgeRegistry)
}
