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
  // A pipeline has INLINE steps (e.g. the requirements reviewer) whose resolved model can't run
  // inline — a subscription-only model with no inline-harness support on this deployment. The
  // remedy differs from `providers_unconfigured` (pick an inline-capable preset / model), so the
  // SPA steers the user to the model preset rather than the provider-key setup.
  'preset_unsatisfiable',
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
  // A pipeline with visual steps (`tester-ui` / `visual-confirmation`) was started on a frame
  // with no UI to exercise — neither a `frontend` frame nor a frame a frontend links to.
  'visual_pipeline_no_frontend',
  // A pipeline uses a model whose FAMILY the account-wide model policy blocks (on the
  // effective route) — the SPA steers the user to pick an allowed model / family.
  'model_policy_blocked',
  // An account-settings write tried to set a model-family policy on a deployment that does
  // not support it (plain local mode) — the policy is a hosted/mothership-only control.
  'model_policy_unsupported',
] as const

export type ConflictReason = (typeof CONFLICT_REASONS)[number]
