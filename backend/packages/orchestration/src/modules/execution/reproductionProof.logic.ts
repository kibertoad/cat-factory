import type {
  AgentConfigValues,
  PipelineStep,
  ReproductionReport,
  ResolvedReproduction,
} from '@cat-factory/kernel'
import {
  REPRODUCTION_DEFAULT_MAX_ATTEMPTS,
  REPRODUCTION_MAX_TEST_PATHS,
  parseReproductionReport,
} from '@cat-factory/contracts'
import { reproTestOutcome } from '@cat-factory/agents'

// Pure logic for the BUGFIX REPRODUCTION PROOF phase (docs/initiatives/bugfix-reproduction-proof.md).
//
// The engine resolves the per-task tri-state + the run's reproduction DECLARATION into the spec
// the container executor forwards on a PR-opening coding job body. Side-effect-free so it is
// unit- and conformance-testable without the engine's I/O.
//
// The declaration seam is deliberately singular: it is the prior `repro-test` step's structured
// outcome, NOT a new structured tail on the coder (which is a side-effect kind that legitimately
// ends with no final text). See the initiative's D3.

/** The producer kind the proof phase attaches to (the Coder, which opens the PR). */
export const REPRODUCTION_PROOF_PRODUCER_KIND = 'coder'

/** The step kind whose structured outcome carries the reproduction declaration. */
export const REPRO_DECLARATION_KIND = 'repro-test'

/** Descriptor id of the Coder's reproduction-proof tri-state (mirrors the agents constant). */
export const CODER_REPRODUCTION_PROOF_CONFIG_ID = 'coder.reproductionProof'

/** The per-task tri-state that gates the phase. */
export type ReproductionProofTriState = 'auto' | 'always' | 'off'

/**
 * The block's tri-state for the proof phase: the explicit `coder.reproductionProof` agent-config
 * choice when set to a known value, else the default `auto`. Lenient (any unknown value falls
 * back to `auto`) exactly like {@link resolveForkTriState} — an agent-config bag is free-form
 * JSON, so a stale or hand-edited value must degrade rather than throw.
 */
export function resolveReproductionTriState(
  agentConfig: AgentConfigValues | undefined,
): ReproductionProofTriState {
  const chosen = agentConfig?.[CODER_REPRODUCTION_PROOF_CONFIG_ID]
  return chosen === 'always' || chosen === 'off' ? chosen : 'auto'
}

/**
 * The reproduction DECLARATION carried by the run so far: the last prior `repro-test` step's
 * structured outcome, parsed leniently. `undefined` when no such step ran (or its reply was
 * unusable), which is the signal that `auto` must not run the phase — there is nothing to prove.
 *
 * Reads the LAST matching step rather than the first: a retried/re-run reproduction step is the
 * one whose declaration describes the branch as it now stands, mirroring `findStep` in
 * `prReport.logic.ts`.
 */
export function reproductionDeclarationFrom(
  steps: readonly PipelineStep[],
  currentStep: number,
): ReturnType<typeof reproTestOutcome.parse> | undefined {
  for (let i = Math.min(currentStep, steps.length) - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (step?.agentKind !== REPRO_DECLARATION_KIND) continue
    const parsed = reproTestOutcome.safeParse(step.custom)
    if (parsed) return parsed
  }
  return undefined
}

/**
 * Resolve the spec a dispatch should carry, or `undefined` for "run the existing path unchanged".
 *
 * `undefined` is returned — and this is the feature's core compatibility promise — whenever:
 * the tri-state is `off`; the dispatched kind is not the PR-opening producer; `auto` found no
 * declaration; the declaration conceded (`not_reproducible`, which is recorded as a structural
 * infeasibility declaration by the engine rather than verified here); or the declaration named
 * no runnable command. In every one of those cases no context field is set, so no job-body field
 * is set, so the harness runs byte-for-byte the code it ran before this feature existed.
 *
 * `always` deliberately does NOT invent a spec when there is no declaration: there is nothing to
 * run, and fabricating a command would produce a false verdict. It differs from `auto` only in
 * that it proceeds for a declaration whose own `outcome` was `partial` — a partially-captured
 * reproduction is still worth proving — where `auto` also proceeds. The meaningful divergence
 * arrives with the tracker-issue-type gating deferred in the initiative's D2; the tri-state is
 * shipped now so the wire contract and the UI control do not have to change later.
 */
export function resolveReproductionSpec(args: {
  agentKind: string
  agentConfig: AgentConfigValues | undefined
  steps: readonly PipelineStep[]
  currentStep: number
  maxAttempts?: number
}): ResolvedReproduction | undefined {
  const { agentKind, agentConfig, steps, currentStep } = args
  if (agentKind !== REPRODUCTION_PROOF_PRODUCER_KIND) return undefined
  if (resolveReproductionTriState(agentConfig) === 'off') return undefined

  const declaration = reproductionDeclarationFrom(steps, currentStep)
  if (!declaration) return undefined
  // A concede is not something to VERIFY — it is a declaration the engine records as-is. Running
  // a command for it would be running nothing.
  if (declaration.outcome === 'not_reproducible') return undefined

  const command = declaration.command?.trim()
  if (!command) return undefined

  const testPaths = declaration.testPaths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, REPRODUCTION_MAX_TEST_PATHS)
  const setupCommand = declaration.setupCommand?.trim()

  return {
    command,
    testPaths,
    ...(setupCommand ? { setupCommand } : {}),
    maxAttempts: args.maxAttempts ?? REPRODUCTION_DEFAULT_MAX_ATTEMPTS,
  }
}

/**
 * The report to record for a run whose reproduction step CONCEDED — the structural
 * infeasibility declaration. Built by the engine (not the harness, which never runs for a
 * concede), so "could not be reproduced" reaches the pull request as a real statement with its
 * reason and the agent's stated alternative verification, rather than as an empty section
 * indistinguishable from a run that never tried.
 *
 * Returns `undefined` when the run carries no concede, so the caller can fold it in branch-free.
 */
export function concededReproductionReport(
  steps: readonly PipelineStep[],
  currentStep: number,
  now: number,
): ReproductionReport | undefined {
  const declaration = reproductionDeclarationFrom(steps, currentStep)
  if (!declaration || declaration.outcome !== 'not_reproducible') return undefined
  return {
    status: 'declared_infeasible',
    command: '',
    testPaths: [],
    attempts: 0,
    maxAttempts: 0,
    ...(declaration.notes?.trim() ? { reason: declaration.notes.trim() } : {}),
    ...(declaration.alternativeVerification?.trim()
      ? { alternativeVerification: declaration.alternativeVerification.trim() }
      : {}),
    at: now,
  }
}

/**
 * Fold a harness-produced reproduction report onto a step, returning whether anything changed.
 *
 * Applied on all three poll paths — the live republish (so a failed verification is visible while
 * the repair loop still runs), the successful terminal result, and the failed terminal result (a
 * job that died for an UNRELATED reason after the proof ran; a failed verification never fails a
 * job by itself). Lenient by construction: a malformed or absent payload leaves the step
 * untouched rather than failing the run, because the report is evidence, never a control signal.
 */
export function applyReproductionReport(step: PipelineStep, raw: unknown): boolean {
  const report = coerceReproductionReport(raw)
  if (!report) return false
  if (sameReproductionReport(step.reproduction ?? null, report)) return false
  step.reproduction = report
  return true
}

/** Parse a harness report defensively; `null` for absent/unparseable payloads. */
export function coerceReproductionReport(raw: unknown): ReproductionReport | null {
  if (raw === undefined || raw === null) return null
  try {
    return parseReproductionReport(raw)
  } catch {
    return null
  }
}

/**
 * Whether two reports are the same publish. Compared on the verdict identity rather than
 * deep-equality of the (potentially several KB of) captured output tails, so an idle poll
 * re-offering the same report doesn't churn storage or the event stream — the
 * `sameValidationReport` treatment, for the same reason.
 */
/**
 * Record a settled coding step's reproduction outcome: the harness's verdict when one came back,
 * else — for a run whose reproduction step CONCEDED, which dispatches no proof because there is
 * nothing to run — the structural infeasibility declaration the engine mints itself.
 *
 * The concede branch is gated on the PR-opening producer kind, so every other step in the run
 * doesn't pick up the same declaration and litter the timeline with duplicate cards.
 *
 * Lives here rather than inline in `RunDispatcher.recordStepResult` so the dispatcher keeps a
 * one-line delegate and the whole "which report does this step get" rule sits with the rest of
 * the feature's pure logic, where it is directly testable.
 */
export function recordReproductionOutcome(
  step: PipelineStep,
  raw: unknown,
  run: { steps: readonly PipelineStep[]; currentStep: number },
  now: number,
): void {
  if (applyReproductionReport(step, raw)) return
  if (step.agentKind !== REPRODUCTION_PROOF_PRODUCER_KIND) return
  const conceded = concededReproductionReport(run.steps, run.currentStep, now)
  if (conceded) step.reproduction = conceded
}

function sameReproductionReport(a: ReproductionReport | null, b: ReproductionReport): boolean {
  if (!a) return false
  return (
    a.status === b.status &&
    a.attempts === b.attempts &&
    a.at === b.at &&
    a.base?.exitCode === b.base?.exitCode &&
    a.final?.exitCode === b.final?.exitCode
  )
}
