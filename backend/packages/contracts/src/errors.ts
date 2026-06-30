// Wire-level error vocabulary shared by the backend (kernel `ConflictError`) and the SPA.

/**
 * Machine-readable reason codes carried on a 409 conflict's `error.details.reason`, so a
 * client can react to a SPECIFIC conflict precisely (e.g. open the AI-provider setup for
 * `providers_unconfigured`) instead of string-matching the human message.
 *
 * Single source of truth lives HERE (a wire shape shared by SPA + backends, like the rest
 * of this package) so a new reason forces BOTH sides to update: the kernel re-exports the
 * type for `ConflictError`, and the SPA keys an exhaustive `Record<ConflictReason, …>` of
 * localized titles off it — adding a value without a title trips the frontend typecheck.
 */
export const CONFLICT_REASONS = [
  'providers_unconfigured',
  'dependencies_unmet',
  'task_limit_reached',
  'tester_infra_unsupported',
  'binary_storage_unconfigured',
  'agent_backend_unconfigured',
  'run_not_retryable',
  'no_pr_to_merge',
  'github_not_connected',
  'bootstrap_not_retryable',
  'bootstrap_reference_missing',
  // No workspace handler is configured for a service's declared provision type (the
  // per-service provision-type model — the deployer/tester can't stand the env up).
  'provision_type_unhandled',
] as const

export type ConflictReason = (typeof CONFLICT_REASONS)[number]
