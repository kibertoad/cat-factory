import type { AgentKind } from '@cat-factory/kernel'
import type { AgentKindRegistry } from './registry.js'

// Which agent kinds may be ESTIMATE-GATED — skipped at runtime when the task estimate written by
// an earlier `task-estimator` step falls below the step's thresholds (see `shouldRunGatedStep` /
// `RunDispatcher.skipGatedStep`).
//
// Gating was originally restricted to COMPANION kinds, on the reasoning that skipping a producer
// would starve its downstream steps. That is too strong, and the old catalog proved it: `pl_simple`
// carried no architect and no spec-writer, `pl_quick` carried no reviewer, and both shipped and ran.
// A producer's output reaches later steps as PROMPT CONTEXT (prior step outputs + the in-repo spec),
// not as a precondition — so omitting it degrades the context a later step reasons from rather than
// breaking it.
//
// What genuinely cannot be skipped is a step some OTHER mechanism reads structurally:
//
//   - `merger` — `runOpensPr` tests `instance.steps` for a merger to decide whether a committing
//     kind delivers via a pull request. It reads the AUTHORED steps, not the un-skipped ones, so a
//     skipped merger would leave `spike`/`spec-writer` opening a PR that nothing merges.
//   - `deployer` — `assertDeployerBeforeConsumer` guarantees an environment exists for a tester /
//     human-test / playwright step. Skipping it independently of its consumer would dead-end that
//     consumer. (It is a no-op on an infraless service, so leaving it unconditional costs nothing.)
//   - `conflicts` / `ci` — the mergeability + green-build guards. "Pass the guards" is not
//     negotiable on task size; a small change merged over a red build is the same outage as a big
//     one.
//   - `bug-intake` — pulls the run's work item from a schedule's tracker board. Skipping it leaves
//     the run with no subject at all.
//
// A COMPANION is gatable, and additionally cascades: skipping a producer skips the companion that
// reviews it (see `producerWasSkipped`), because a companion whose producer never ran would
// otherwise grade whatever happened to precede it.
/**
 * Built-in agent kinds that may carry estimate gating. A kind absent from this set is
 * unconditional — {@link isGatableKind} refuses it at pipeline save and at run start.
 */
export const BUILTIN_GATABLE_KINDS = new Set<string>([
  // Companions — the original gatable set. Each also cascades with its producer.
  'reviewer',
  'architect-companion',
  'spec-companion',
  'doc-reviewer',
  // Design / analysis producers. Their output is context for the coder, not a precondition:
  // a task simple enough not to need a design is exactly what the estimate identifies.
  'architect',
  'researcher',
  'spec-writer',
  'requirements-review',
  // Build-adjacent producers whose artifacts are additive.
  'mocker',
  'blueprints',
  'code-commenter',
  // Verification depth. The tester is gatable; `deployer` before it is not (it provisions the
  // environment the tester reads, and is a no-op when the service declares no infra).
  'tester-api',
  'tester-ui',
  'playwright',
  // Documentation of work already done.
  'documenter',
  'business-documenter',
  // Human checkpoints whose whole purpose IS the human. Gating their PRESENCE is escalation —
  // "require a human PR review once risk clears .8" — not the cancellation of an approval pause
  // a pipeline author asked for. That distinction is enforced separately: `assertValidGating`
  // refuses a step carrying BOTH an estimate gate and the `gates[i]` human-approval flag.
  'human-review',
  'human-test',
  'visual-confirmation',
])

/**
 * Whether `kind` may carry estimate gating — its registered `gatable` flag when a deployment
 * registered the kind, else the built-in set.
 *
 * The registry lookup comes FIRST and is authoritative when present, mirroring
 * `registeredAgentTuning` / `webResearchHintFor`: a deployment that registers a kind owns the
 * answer for it. Built-in kinds are not registry entries (see `custom-agents.md` — the built-ins
 * are not migrated to the manifest model), so `registry.gatable(kind)` is `undefined` for every
 * one of them and the set below is what answers.
 */
export function isGatableKind(kind: AgentKind, registry?: AgentKindRegistry): boolean {
  return registry?.gatable(kind) ?? BUILTIN_GATABLE_KINDS.has(kind)
}
