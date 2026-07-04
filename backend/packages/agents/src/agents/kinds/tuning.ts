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
