// The STRUCTURED failure-cause vocabulary a harness reports on a failed job view, and the
// single shared cause → coarse-failure-kind mapper every consuming flow (execution, bootstrap,
// env-config repair) classifies through.
//
// The values are minted inside the container payloads, which are dependency-free published
// images and so cannot import this module — the lists are kept in step BY HAND with:
//   - `backend/internal/executor-harness/src/failure.ts` (`FailureCause`) — everything except
//     `deploy`;
//   - `backend/internal/deploy-harness/src/runner.ts` (`DeployFailureCause`) — the watchdog
//     pair + `agent` + `deploy`.
// Growing either harness union means adding the member HERE (the `Record` drift guard below
// then forces a mapping) in the same change — an unmapped new cause silently degrades to the
// error-string regex fallback on every consumer.
//
// Container EVICTION is deliberately NOT a cause: a harness cannot report its own container
// vanishing, so eviction is minted by the TRANSPORT beside the cause (`RunnerJobView.evicted`,
// or the legacy `(container evicted or crashed)` error string).

/** Every structured failure cause a harness can stamp on a failed job view. */
export const HARNESS_FAILURE_CAUSES = [
  // The two container watchdogs (both harnesses).
  'inactivity-timeout',
  'max-duration',
  // Executor-harness faults: the agent erred/threw, a git op failed, an upstream API call
  // failed, the agent finished without a usable product / without a change to push.
  'agent',
  'git',
  'api',
  'no-usable-output',
  'no-changes',
  // Deploy-harness fault: rendering/applying the Kubernetes manifests failed.
  'deploy',
] as const

/** See {@link HARNESS_FAILURE_CAUSES}; the type the kernel job-view ports carry. */
export type HarnessFailureCause = (typeof HARNESS_FAILURE_CAUSES)[number]

/**
 * Whether a wire value is a known {@link HarnessFailureCause}. Producers that read the cause
 * out of untyped JSON (a pool's mapped response) narrow through this — an unknown value is
 * dropped so the consumer falls back to its error-string regex, exactly as if no cause were
 * reported.
 */
export function isHarnessFailureCause(value: unknown): value is HarnessFailureCause {
  return typeof value === 'string' && (HARNESS_FAILURE_CAUSES as readonly string[]).includes(value)
}

/**
 * The coarse failure kind each cause classifies to. `timeout` / `agent` are members of BOTH
 * `AgentFailureKind` (execution + env-config repair) and `BootstrapFailureKind`, so one map
 * serves every flow. Keyed by the full union on purpose — the Record is the drift guard: a
 * cause added to {@link HARNESS_FAILURE_CAUSES} without a kind fails the typecheck here
 * (the `CONFLICT_TITLE_KEYS` pattern).
 */
const FAILURE_KIND_BY_CAUSE: Record<HarnessFailureCause, 'timeout' | 'agent'> = {
  'inactivity-timeout': 'timeout',
  'max-duration': 'timeout',
  agent: 'agent',
  git: 'agent',
  api: 'agent',
  'no-usable-output': 'agent',
  'no-changes': 'agent',
  deploy: 'agent',
}

/**
 * Map a harness's structured failure cause onto the coarse failure kind, preferred over the
 * error-string regex when present: `failureKindFromHarnessCause(view.failureCause) ??
 * classifyXFailure(error)`. Accepts the raw optional wire value; returns undefined for an
 * absent/unknown cause so the caller falls back to its regex (an older harness image, or a
 * pool forwarding a free-form value) — crucially including container eviction, which has NO
 * harness cause (see the header) and so routes to `view.evicted` / the regex's `evicted`.
 */
export function failureKindFromHarnessCause(
  cause: string | undefined,
): 'timeout' | 'agent' | undefined {
  return isHarnessFailureCause(cause) ? FAILURE_KIND_BY_CAUSE[cause] : undefined
}
