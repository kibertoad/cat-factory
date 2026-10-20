/**
 * The job id for ONE dispatch of ONE step: the run (execution) id, the agent kind, and (past the
 * first job of that kind in the run) the `dispatchEpoch`.
 *
 * A run executes a sequence of steps that all share the one per-run container, so each job needs
 * an id that is UNIQUE WITHIN THE RUN: the harness keys its per-kind job registries by it, and two
 * jobs sharing an id alias there (the bug where an `architect` explore poll read back the
 * `spec-writer`'s result). The run itself is addressed separately by the execution id.
 *
 * The epoch is what makes that uniqueness total, because the engine dispatches one kind more than
 * once per run in two ways: a step RE-dispatched (a Tester re-test after a fixer round, a gate's
 * helper retry, a companion's rework round, an eviction recovery) and the same helper kind
 * escalated off DIFFERENT steps (`fixer` serves four gates). The harness re-attaches to an EXISTING
 * job id rather than re-running (replay idempotency), and a container-reusing transport keeps that
 * registry alive across rounds, so a reused id replays a completed job: the Tester that appeared to
 * "pass regardless" and never re-tested. `dispatchEpochFor` counts the run's prior dispatches of the
 * kind, so the id names the n-th job of that kind and the run's first keeps the unsuffixed shape.
 *
 * It lives in KERNEL rather than beside the container executor because THREE layers now have to
 * produce the same string from the same three facts and none of them can be handed it by the
 * others: the container executor mints it at dispatch; the deployer's own dispatch logic mirrors it
 * so a Workflows replay reproduces the id; and the ENGINE mints it as a delegated step's
 * correlation key, which it must COMMIT before the external executor is ever called (see
 * `DelegationBrief.correlationKey`). Three hand-kept copies of one formula is how a replay comes to
 * address a job nobody started.
 */
export function stepJobId(executionId: string, agentKind: string, dispatchEpoch = 0): string {
  const base = `${executionId}-${agentKind}`
  return dispatchEpoch > 0 ? `${base}-${dispatchEpoch}` : base
}
