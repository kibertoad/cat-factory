import type { AgentKind } from './primitives.js'

// Which agent kinds may be ESTIMATE-GATED — skipped at runtime when the task estimate written by an
// earlier `task-estimator` step falls below the step's thresholds.
//
// This lives in `contracts` rather than beside the engine because TWO surfaces must answer the
// question identically, and they are in different packages: the engine's shape validation
// (`assertValidGating`, refusing an illegal pipeline at save AND at run start) and the SPA's
// pipeline-health advisory, which re-derives the same verdict client-side to tell a workspace which
// of its stored pipelines would fail. When the SPA carried its own copy of the rule, generalising
// the engine's rule past companions left the advisory declaring a pipeline the product itself
// SHIPS invalid — and because the advisory auto-opens a modal over the board, that is not a stale
// warning but an unusable board. A shared constant is the only shape in which the two cannot
// disagree.
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
 * unconditional — the engine refuses it at pipeline save and at run start, and the SPA's
 * pipeline-health advisory flags a stored pipeline that carries it.
 *
 * A DEPLOYMENT-registered kind answers for itself through its own `gatable` flag; that lookup needs
 * the app-owned agent-kind registry, which is a backend concept, so it stays in
 * `@cat-factory/agents` (`isGatableKind`) and reads this set as its fallback.
 */
export const BUILTIN_GATABLE_KINDS: ReadonlySet<string> = new Set<string>([
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
  // Build-adjacent producers whose artifacts are additive.
  'mocker',
  'blueprints',
  'code-commenter',
  // Verification depth. The tester is gatable; `deployer` before it is not (it provisions the
  // environment the tester reads, and is a no-op when the service declares no infra).
  'tester-api',
  'tester-ui',
  'playwright',
  // The bugfix reproduction test. It is the most expensive thing a small bugfix pays for (a
  // `container-coding` dispatch: a real checkout, a commit and a push) and the least likely to
  // earn its keep on a one-line change, which is exactly the range estimate gating exists to
  // collapse into one preset.
  //
  // It qualifies under this set's own test rather than by convenience: its absence THINS a run
  // where `merger`'s BREAKS one. Nothing reads the declaration structurally except the
  // reproduction proof, which resolves to "no spec" and simply does not run, and the PR report
  // then names the skip as its own cause (see `composeReproduction`). What a reader loses is the
  // evidence, and the report says so out loud instead of implying the phase was off.
  //
  // Shipped GATABLE but ungated: no built-in preset carries `gating` on it, so the default cost
  // is unchanged and an author who wants a trivial bugfix to skip the reproduction opts in.
  'repro-test',
  // Documentation of work already done.
  'documenter',
  'business-documenter',
  // The post-implementation re-assessment. It qualifies under this set's own test: nothing reads
  // the measured estimate structurally, so its absence leaves the task holding the FORECAST it
  // already had (or no estimate at all, exactly as before the step existed) rather than
  // dead-ending anything. Gating it is the cheap direction too: it costs a read-only container
  // run, and a task the forecast put at the bottom of every axis is the one least worth measuring.
  //
  // Shipped GATABLE but ungated, like `repro-test`: no built-in preset carries the step at all.
  'task-reassessor',
  // Human checkpoints whose whole purpose IS the human. Gating their PRESENCE is escalation —
  // "require a human PR review once risk clears .8" — not the cancellation of an approval pause
  // a pipeline author asked for. That distinction is enforced separately: the gating validation
  // refuses a step carrying BOTH an estimate gate and the `gates[i]` human-approval flag.
  //
  // `requirements-review` belongs HERE, not with the design producers above: it is not a producer
  // whose artifact later steps read, it is an iterative answer/dismiss/re-review conversation that
  // PARKS the run. Its pause is intrinsic to the kind rather than expressed as `gates[i]`, so the
  // exclusivity rule cannot see it — which makes it the one entry in this set where a reader has to
  // take the escalation argument on its own terms rather than leaning on that guard. It holds for
  // the same reason it holds for `human-review`: gating the step is the author CHOOSING to have the
  // checkpoint conditionally, never a third party deleting a pause somebody else asked for. An
  // author who wants the conversation unconditionally leaves the step ungated, and one who
  // additionally marks it `gates[i]` is refused outright.
  'requirements-review',
  'human-review',
  'human-test',
  'visual-confirmation',
])

/**
 * Whether `kind` may carry estimate gating according to the BUILT-IN vocabulary.
 *
 * Callers that can see the agent-kind registry should prefer `isGatableKind` from
 * `@cat-factory/agents`, which lets a deployment-registered kind override this answer for itself.
 * The SPA has no registry, so this is the predicate it uses.
 */
export function isBuiltinGatableKind(kind: AgentKind | string): boolean {
  return BUILTIN_GATABLE_KINDS.has(kind)
}

/**
 * The built-in agent kinds that WRITE a task estimate, and so satisfy the prerequisite every
 * estimate gate carries: an enabled one of these must run EARLIER in the chain, or the gate has
 * nothing to consult.
 *
 * Two members, because the estimate has two producers at opposite ends of a run (see
 * `taskEstimateBasisSchema`): `task-estimator` FORECASTS it up front, `task-reassessor` MEASURES
 * it against the change that was made. A gate placed after either one reads a real estimate, so
 * the prerequisite is about the FIELD being populated rather than about which agent populated it.
 *
 * Lives here beside {@link BUILTIN_GATABLE_KINDS} for the same reason that set does: the engine's
 * shape validation (`assertValidGating`, refusing an illegal pipeline at save AND at run start)
 * and the SPA's pipeline-health advisory plus its builder draft warning all state this rule, in
 * three different packages. Three hand-written copies of "is there an estimator before this step"
 * is exactly how the advisory came to declare a shipped preset invalid.
 */
export const ESTIMATE_PRODUCING_KINDS: ReadonlySet<string> = new Set<string>([
  'task-estimator',
  'task-reassessor',
])

/** Whether `kind` writes the task estimate an estimate gate consults. */
export function producesTaskEstimate(kind: AgentKind | string): boolean {
  return ESTIMATE_PRODUCING_KINDS.has(kind)
}
