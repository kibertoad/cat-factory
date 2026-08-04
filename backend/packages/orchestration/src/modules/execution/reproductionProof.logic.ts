import type {
  AgentConfigValues,
  PipelineStep,
  ReproductionProofMode,
  ReproductionReport,
  ResolvedReproduction,
} from '@cat-factory/kernel'
import {
  REPRODUCTION_DEFAULT_MAX_ATTEMPTS,
  REPRODUCTION_MAX_COMMAND_CHARS,
  REPRODUCTION_MAX_TEST_PATHS,
  REPRODUCTION_MAX_TEST_PATH_CHARS,
  parseReproductionProofMode,
  parseReproductionReport,
} from '@cat-factory/contracts'
import { CODER_REPRODUCTION_PROOF_CONFIG_ID, reproTestOutcome } from '@cat-factory/agents'

// Pure logic for the BUGFIX REPRODUCTION PROOF phase (backend/docs/adr/0033-bugfix-reproduction-proof.md).
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

/**
 * The block's tri-state for the proof phase: the explicit `coder.reproductionProof` agent-config
 * choice when set to a known value, else the default `auto`. Lenient (any unknown value falls
 * back to `auto`) exactly like `resolveForkTriState` — an agent-config bag is free-form JSON, so
 * a stale or hand-edited value must degrade rather than throw. Both the descriptor id and the
 * union itself come from their owning packages rather than being restated here: a rename in
 * `@cat-factory/agents` would otherwise leave the engine reading a key nothing writes.
 */
export function resolveReproductionTriState(
  agentConfig: AgentConfigValues | undefined,
): ReproductionProofMode {
  return parseReproductionProofMode(agentConfig?.[CODER_REPRODUCTION_PROOF_CONFIG_ID])
}

/**
 * The reproduction DECLARATION carried by the run so far: the last prior `repro-test` step's
 * structured outcome. `undefined` when no such step ran, or when its reply did not actually
 * declare an outcome — which is the signal that `auto` must not run the phase (there is nothing
 * to prove) AND that no infeasibility may be attributed to the agent.
 *
 * The raw `outcome` must be one of the three literals VERBATIM. `reproTestOutcome` falls back to
 * `not_reproducible` for an unreadable reply — a deliberately conservative default for telling
 * the coder there is no trustworthy failing test — but this feature PUBLISHES that value as the
 * agent's own structural declaration, so a fallback must never reach it. Otherwise a malformed
 * reply (`{}` parses fine) would be recorded as "the agent declared the bug non-reproducible"
 * with a blank reason: a false attribution AND exactly the empty section this feature exists to
 * eliminate.
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
    if (!declaresOutcome(step.custom)) continue
    const parsed = reproTestOutcome.safeParse(step.custom)
    if (parsed) return parsed
  }
  return undefined
}

/** Whether a raw structured reply literally named an outcome (vs. the schema's fallback). */
function declaresOutcome(custom: unknown): boolean {
  if (typeof custom !== 'object' || custom === null) return false
  const outcome = (custom as { outcome?: unknown }).outcome
  return outcome === 'reproduced' || outcome === 'partial' || outcome === 'not_reproducible'
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
 * run, and fabricating a command would produce a false verdict. So TODAY it resolves identically
 * to `auto` — the divergence arrives with the tracker-issue-type gating deferred in the
 * initiative's D2, which is why the task-facing control is deferred with it rather than shipping
 * two options a user cannot tell apart. The wire value is accepted now so the contract does not
 * change when the control lands.
 *
 * The declared command and setup command are MODEL-AUTHORED strings the harness will run through
 * `sh -c`, and the declared paths are applied onto a base worktree, so both are BOUNDED here at
 * the resolution boundary — the last place the engine controls before they cross into a job body.
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
  if (!command || command.length > REPRODUCTION_MAX_COMMAND_CHARS) return undefined

  const setupCommand = declaration.setupCommand?.trim()
  // An over-long setup command declines the whole spec rather than being dropped: running the
  // final tree with a setup the base tree never got is precisely the asymmetry that manufactures
  // a false `reproduced` (the initiative's D4).
  if (setupCommand && setupCommand.length > REPRODUCTION_MAX_COMMAND_CHARS) return undefined

  const { paths: testPaths, omitted } = sanitizeTestPaths(declaration.testPaths)

  return {
    command,
    testPaths,
    ...(omitted > 0 ? { omittedTestPaths: omitted } : {}),
    ...(setupCommand ? { setupCommand } : {}),
    maxAttempts: args.maxAttempts ?? REPRODUCTION_DEFAULT_MAX_ATTEMPTS,
  }
}

/**
 * Bound and sanitize the declared test paths, reporting how many were DROPPED.
 *
 * These paths are not decoration: the harness applies them onto the base worktree to rebuild the
 * pre-fix tree, so an absolute path or a `..` segment would write outside the checkout, and an
 * over-cap list would rebuild that tree from an incomplete reproduction. Both are refused, and
 * the count is carried on the spec — a dropped path can green the base and read as "the test does
 * not capture the defect", so a silent truncation would launder a broken input into a verdict.
 */
function sanitizeTestPaths(declared: readonly string[]): { paths: string[]; omitted: number } {
  const paths: string[] = []
  let omitted = 0
  for (const raw of declared) {
    if (paths.length >= REPRODUCTION_MAX_TEST_PATHS) {
      omitted += 1
      continue
    }
    const path = raw.trim().replace(/\\/g, '/')
    if (!isSafeTestPath(path)) {
      if (path.length > 0) omitted += 1
      continue
    }
    paths.push(path)
  }
  return { paths, omitted }
}

/**
 * A repo-relative path with no traversal, no root/drive anchor, no leading dash, no git PATHSPEC
 * MAGIC and a sane length. Mirrored by the harness's own `isSafeTestPath`
 * (`executor-harness/src/reproduction-proof.ts`), which re-checks at its trust boundary — keep the
 * two in step.
 *
 * The magic exclusion carries the weight here. The harness hands these to
 * `git checkout <finalSha> -- <path>`, where `--` stops a path being read as a REVISION but does
 * nothing about pathspec syntax: `:(glob)**`, `*` and `foo/*.ts` are all valid pathspecs. One of
 * those would apply far more of the final tree onto the pre-fix worktree than the declared
 * reproduction — dragging the fix across and GREENING the base, which surfaces as "the check
 * passed before your change" about a test that is fine. These strings are MODEL-AUTHORED, so that
 * is a reachable input, not a hypothetical one.
 */
function isSafeTestPath(path: string): boolean {
  if (path.length === 0 || path.length > REPRODUCTION_MAX_TEST_PATH_CHARS) return false
  if (path.startsWith('/') || path.startsWith('~') || path.startsWith('-')) return false
  if (path.startsWith(':') || /[*?[\]]/.test(path)) return false
  if (/^[a-zA-Z]:\//.test(path)) return false
  return !path.split('/').includes('..')
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
  const reason = declaration.notes?.trim()
  const alternativeVerification = declaration.alternativeVerification?.trim()
  return {
    status: 'declared_infeasible',
    command: '',
    testPaths: [],
    attempts: 0,
    maxAttempts: 0,
    ...(reason ? { reason } : {}),
    ...(alternativeVerification ? { alternativeVerification } : {}),
    // A concede that named NEITHER a reason nor an alternative is a declaration in form only.
    // Say so, rather than rendering an infeasibility card whose body happens to be blank — the
    // blank is indistinguishable from a rendering bug, which is how "nobody tried" creeps back in
    // through the door this feature closed.
    ...(reason || alternativeVerification
      ? {}
      : { note: 'The reproduction step declared the bug non-reproducible but gave no reason.' }),
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
  // A report already on the step is never displaced by the minted concede. `applyReproductionReport`
  // returns false BOTH for "nothing came back" and for "the terminal result re-offered the report
  // the live poll already applied" — without this guard the second case would overwrite a proof
  // that actually ran with the older, weaker declaration.
  if (step.reproduction) return
  if (step.agentKind !== REPRODUCTION_PROOF_PRODUCER_KIND) return
  const conceded = concededReproductionReport(run.steps, run.currentStep, now)
  if (conceded) step.reproduction = conceded
}

/**
 * Whether two reports are the same publish. Compared on the verdict identity rather than
 * deep-equality of the (potentially several KB of) captured output tails, so an idle poll
 * re-offering the same report doesn't churn storage or the event stream — the
 * `sameValidationReport` treatment, for the same reason.
 *
 * `at` participates, so the harness MUST stamp a fresh timestamp on every publish (a Phase B
 * invariant); every other field compared here is one whose change a reviewer would actually see,
 * so a same-timestamp republish that altered the verdict still lands.
 */
function sameReproductionReport(a: ReproductionReport | null, b: ReproductionReport): boolean {
  if (!a) return false
  return (
    a.status === b.status &&
    a.attempts === b.attempts &&
    a.at === b.at &&
    a.note === b.note &&
    samePhase(a.base, b.base) &&
    samePhase(a.final, b.final)
  )
}

function samePhase(a: ReproductionReport['base'], b: ReproductionReport['base']): boolean {
  return a?.exitCode === b?.exitCode && a?.passed === b?.passed && a?.setupFailed === b?.setupFailed
}
