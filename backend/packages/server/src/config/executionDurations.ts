// The built-in defaults for {@link ExecutionConfig}'s duration knobs, shared by both facades'
// config loaders.
//
// They live here rather than as a literal in each loader for the same reason the parser does
// (`duration.ts`): agreeing on how a value is READ buys nothing if the two runtimes disagree on
// what it is when the variable is UNSET, which is the common case. Their numeric siblings
// (`jobMaxPolls` and friends) stay in each loader: nothing parses those differently per runtime,
// so they carry no such asymmetry to close.

/**
 * Ceiling on ONE pipeline-step advance, and on one status read (`ADVANCE_TIMEOUT`).
 *
 * A WEDGE detector, not a latency budget, and sized accordingly. One advance legitimately
 * contains several SEQUENTIAL inline LLM calls: a requirements-review incorporation cycle
 * (incorporate, then re-review), a consensus debate's rounds, a judge, the task estimator, a
 * recommendation fill. Each is minutes against a slow or locally-run model, so a ceiling sized
 * near the typical advance cuts healthy runs.
 *
 * The two mistakes are not symmetric, which is what fixes the number. Firing LATE only delays a
 * wedged run's failure, and it is still bounded far below the 24h pg-boss expire cap that F9's
 * wedge used to run to. Firing EARLY ends a healthy run: Node deliberately does not retry a
 * timed-out advance (a second concurrent one would double-drive the run), and the Worker gives
 * it three attempts that a genuinely slow advance would simply spend. So the ceiling is set
 * above the slowest legitimate advance rather than near the typical one.
 */
export const DEFAULT_ADVANCE_TIMEOUT = '30 minutes'

/** How long a run parks on one `waitForEvent` chunk before re-checking storage (`DECISION_TIMEOUT`). */
export const DEFAULT_DECISION_TIMEOUT = '24 hours'

/** Cadence for polling a dispatched container job (`JOB_POLL_INTERVAL`). */
export const DEFAULT_JOB_POLL_INTERVAL = '15 seconds'

/** Cadence for re-running a polling gate's precheck (`CI_POLL_INTERVAL`). */
export const DEFAULT_CI_POLL_INTERVAL = '30 seconds'
