// Which polling-GATE kinds park the run on a human, and are therefore a static park surface a
// start path can refuse on.
//
// A gate is normally the opposite of a park: it probes a provider, escalates to a helper agent on a
// negative verdict, and settles itself. One gate kind is different. `human-review` declares
// `pollExhaustion: 'rearm'` with an effectively unbounded attempt budget, which is the engine's way
// of saying "there is no deadline for a human reviewer": running out of polls is not a verdict, so
// the step re-arms and the run waits indefinitely for a person on the PR.
//
// That makes it a human park in exactly the sense the public API's admission rule cares about, and
// it is STATIC: the kind sits in the pipeline's step chain at save time, unlike an agent-raised
// decision or a judge `park` disposition, which only exist once a run is under way.
//
// This lives in `contracts` rather than beside either consumer because the two packages that must
// agree cannot see each other: `@cat-factory/server`'s public-API admission reads it, and
// `@cat-factory/gates` (which owns the gate definitions and therefore the `pollExhaustion` values)
// pins it with a drift guard. A shared constant is the only shape in which those two cannot
// disagree. The same reasoning as `BUILTIN_GATABLE_KINDS` in `agent-gating.ts`.

/**
 * Built-in gate kinds whose poll never times out because they are waiting on a HUMAN, so a step
 * carrying one can park the run indefinitely.
 *
 * Membership is equivalent to the gate's `pollExhaustion: 'rearm'` declaration, and
 * `@cat-factory/gates`' `human-wait-parity.test.ts` fails the build if the two ever disagree: a new
 * built-in gate that waits on a human cannot ship without being classified here.
 *
 * Only BUILT-IN gates are covered. A deployment that registers its own unbounded-wait gate is not
 * seen by the static rule (reading a registered gate's `pollExhaustion` means invoking its factory
 * with an engine context, which a request-time admission check has no business doing), so the run
 * is admitted and the park is answered in the app. Stated rather than silently assumed: see
 * ADR 0032.
 */
export const HUMAN_WAIT_GATE_KINDS: ReadonlySet<string> = new Set<string>([
  // Waits for a real human code review on the PR. `pollExhaustion: 'rearm'`, an effectively
  // infinite attempt budget, and a notification (not a timeout) as the nudge.
  'human-review',
])

/**
 * Every gate kind the platform itself ships, human-wait and bounded alike.
 *
 * What it is FOR is the negative: a gate step whose kind is NOT in here was registered by the
 * DEPLOYMENT through the public `GateRegistry` seam, and the note above is why nothing outside
 * `@cat-factory/gates` can then say whether it ever ends on its own. That is a fact worth
 * REPORTING rather than one to silently assume either way — a run sitting on such a gate with an
 * empty public decision list is either mid-probe or waiting on a person forever, and only the
 * deployment that registered it knows which.
 *
 * Pinned by the same drift guard as {@link HUMAN_WAIT_GATE_KINDS}, derived from the built-in
 * registry, so a new built-in cannot ship without landing here.
 */
export const BUILTIN_GATE_KINDS: ReadonlySet<string> = new Set<string>([
  'ci',
  'conflicts',
  'post-release-health',
  'human-review',
  'doc-quality',
])
