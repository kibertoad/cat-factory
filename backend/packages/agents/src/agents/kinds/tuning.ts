import type { AgentKindRegistry } from './registry.js'

// Per-agent-kind execution tuning the backend folds into a container dispatch's job
// body, so a kind whose normal working pattern differs from the default isn't killed
// by the harness's one-size anti-rabbithole guard. Today this carries only the
// progress-guard knobs, which are LOOSEN-ONLY: a read-heavy kind tolerates more
// web/exploration before it counts as a stall. The loosen-only contract is enforced in
// the harness (`mergeGuardLimits` clamps each override up to the base), so even a custom
// kind that supplies a value TIGHTER than the default can't tighten a guard and abort a
// legitimately-progressing run — the worst a bad entry does is no-op. The built-in
// entries below all raise a limit.
//
// Resolution mirrors the web-research-hint seam: a registered (custom) kind's own
// `tuning` wins, then these built-in defaults, then nothing (the harness keeps its
// env/built-in defaults for every knob). Data-driven — no `switch(agentKind)`.

/** Per-knob progress-guard overrides for a kind (each optional; absent ⇒ harness default). */
export interface AgentGuardTuning {
  /** Non-exploration tool calls allowed before the first edit (the no-edit bound). */
  maxToolCallsWithoutEdit?: number
  /** Consecutive failing tool calls tolerated before aborting. */
  maxConsecutiveErrors?: number
  /** Consecutive web-search/fetch calls tolerated before it counts as a research loop. */
  maxConsecutiveWebCalls?: number
  /**
   * Consecutive tool-server (`mcp__*`) calls tolerated before it counts as a lookup loop. Raise it
   * for a kind whose PRIMARY working tool is an MCP server, the way `researcher` raises the web cap.
   */
  maxConsecutiveMcpCalls?: number
  /**
   * Consecutive read-only calls of ANY exempt family (reads, searches, web, tool servers, subagent
   * dispatches) tolerated with no action call between them. The backstop above the per-family caps,
   * so raising one of those without raising this leaves the harness's own ceiling in place.
   */
  maxConsecutiveNonActionCalls?: number
}

/** Execution tuning for an agent kind (guard limits only, for now). */
export interface AgentTuning {
  guardLimits?: AgentGuardTuning
}

// Built-in per-kind tuning. Deliberately sparse: only kinds with a documented reason
// their normal pattern trips a default guard get an entry — everything else inherits
// the harness defaults unchanged. Every override here LOOSENS a limit.
const BUILTIN_AGENT_TUNING: Record<string, AgentTuning> = {
  // Conflict resolution legitimately retries failing merges/builds/tests more than a
  // typical run while it converges, so give it more headroom on the error streak before
  // the guard calls it stuck (default 12).
  'conflict-resolver': { guardLimits: { maxConsecutiveErrors: 20 } },
  // Web search is the researcher's PRIMARY tool — a real survey is many searches in a
  // row, which the default consecutive-web cap (25) would mistake for a rabbit-hole.
  researcher: { guardLimits: { maxConsecutiveWebCalls: 60 } },
  // Tech-debt analysis leans on web checks (deprecations, CVEs, EOL) more than a coding
  // run, so it tolerates a longer research burst before the web guard fires.
  analysis: { guardLimits: { maxConsecutiveWebCalls: 40 } },
}

/**
 * The execution tuning for `kind`: a registered kind's own `tuning` wins, else the
 * built-in default, else undefined (the harness keeps its env/built-in defaults for
 * every knob). Returns the override object as-is — the dispatcher spreads it into the
 * job body and the harness clamps each value.
 */
export function agentTuningFor(kind: string, registry: AgentKindRegistry): AgentTuning | undefined {
  return registry.tuning(kind) ?? BUILTIN_AGENT_TUNING[kind]
}

// The no-edit exploration allowance for a task of complexity 0 — mirrors the harness's
// `DEFAULT_PROGRESS_GUARD_LIMITS.maxToolCallsWithoutEdit`, so a complexity-0 override is a
// no-op after the harness's loosen-only merge against its own (env-tunable) default.
const NO_EDIT_ALLOWANCE_BASE = 40
// Extra allowance at complexity 1.0 — i.e. a maximally-complex task tolerates ~2× the base
// exploration before its first edit trips the no-edit guard.
const NO_EDIT_ALLOWANCE_COMPLEXITY_SPAN = 40

/**
 * Extend a kind's guard tuning with an estimator-driven no-edit allowance. The task-estimator's
 * `complexity` (0..1, present only when an estimator step ran earlier in the pipeline) raises
 * `maxToolCallsWithoutEdit` proportionally — a more complex task legitimately reads/probes more
 * before its first edit, so it earns a larger exploration budget before the no-edit guard calls
 * it stalled. Deliberately conservative and LOOSEN-ONLY: with no estimate the kind's tuning (and
 * the harness default) stands unchanged, so only ABSOLUTE spiralling is caught; and the value
 * only ever RAISES the allowance (max with any per-kind tuning; the harness then clamps it up to
 * its env default), so a low-complexity task is never given a smaller budget than the floor. Only
 * the no-edit bound scales — the error-streak and web-loop caps are risk-orthogonal and keep
 * their per-kind tuning.
 */
export function withComplexityAllowance(
  tuning: AgentGuardTuning | undefined,
  complexity: number | undefined,
): AgentGuardTuning | undefined {
  if (typeof complexity !== 'number' || !Number.isFinite(complexity)) return tuning
  const clamped = Math.max(0, Math.min(1, complexity))
  const scaled = NO_EDIT_ALLOWANCE_BASE + Math.round(clamped * NO_EDIT_ALLOWANCE_COMPLEXITY_SPAN)
  const maxToolCallsWithoutEdit = Math.max(scaled, tuning?.maxToolCallsWithoutEdit ?? 0)
  return { ...tuning, maxToolCallsWithoutEdit }
}
