// Wire-level error vocabulary shared by the backend (kernel `ConflictError`) and the SPA.

/**
 * The STATUS CLASS every error envelope carries as `error.code` — the coarse "what kind of
 * refusal is this" axis, one step above the machine-readable `details.reason` that says WHY.
 *
 * Single source of truth lives HERE for the same reason {@link CONFLICT_REASONS} does: it is a
 * wire shape both sides read. The kernel derives `DomainErrorCode` from it (so `DomainError`
 * and `STATUS_BY_CODE` cannot drift from what the SPA can present), and the SPA keys an
 * exhaustive `Record<…, string>` of generic translated descriptions off {@link API_ERROR_CODES}
 * — adding a code without wording trips the frontend typecheck.
 */
export const DOMAIN_ERROR_CODES = [
  'not_found',
  'validation',
  'conflict',
  'credential_required',
  'forbidden',
  'unavailable',
  'unauthorized',
  'rate_limited',
] as const

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number]

/**
 * Every `error.code` value that can reach a client: the domain codes above plus `internal`,
 * which is NOT a `DomainError` — it is what the shared `handleError` emits for an unexpected
 * fault (a 500 whose message is deliberately the fixed `Internal server error`, never the
 * thrown text). A client presenting failures generically must handle both, so this — not
 * {@link DOMAIN_ERROR_CODES} — is the union the SPA maps.
 */
export const API_ERROR_CODES = [...DOMAIN_ERROR_CODES, 'internal'] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

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
  // The block's PR came from a DRY RUN, so the platform merge path refuses it. Kept apart from
  // `no_pr_to_merge` because the PR is real and awaiting review — what is missing is the
  // authority to land it, and the remedy is to re-run the task live rather than to look for a
  // PR that does not exist.
  'dry_run_not_mergeable',
  // The run's initiator holds a role whose merge preset allowlists which change classes it may
  // land, and this pull request's class is outside that list. Kept apart from
  // `dry_run_not_mergeable` because the remedies are opposite: re-running live changes nothing
  // here (the same role would produce the same refusal), and what does resolve it is a teammate
  // whose role may land this class, or an operator widening the allowlist. `details.changeClass`
  // names the class that was refused.
  'submission_not_allowed',
  'github_not_connected',
  'bootstrap_not_retryable',
  'bootstrap_reference_missing',
  // A document is already attached to a DIFFERENT live task. A document row carries a single
  // `linkedBlockId`, so attaching it again would MOVE the link rather than copy it, silently
  // stripping the earlier task of a document it was created with. Same rule and same shape as
  // `ticket_already_linked`: `details.taskId` names the holder so the caller can follow it.
  'document_already_linked',
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
  // A `docker-compose`/`kubernetes`/`custom` service's pipeline reaches a Tester / human-test /
  // playwright step with no enabled `deployer` before it, so nothing would provision the env it
  // needs — the run would dead-end inside the consumer. The Deployer is the single provisioner.
  'deployer_required_before_tester',
  // A pipeline INCLUDES an enabled `deployer` step, but the SERVICE's ephemeral-environment
  // provisioning config (the in-repo "what/where") is incomplete for its declared type — e.g. a
  // `kubernetes` service with no manifest source, a `docker-compose` one with no compose path, a
  // `custom` one with no manifest id. The SPA steers the user to the service's environment config.
  'deployer_service_provisioning_incomplete',
  // A pipeline INCLUDES an enabled `deployer` step and the config is structurally complete, but the
  // live connection probe of the resolved deployment integration (the workspace handler) failed —
  // an unreachable endpoint / apiserver, a revoked token. The SPA steers the user to fix + re-test
  // the infrastructure handler. (A MISSING handler is `provision_type_unhandled`, not this.)
  'deployer_connection_test_failed',
  // The ephemeral-environment self-test was started against something other than a service
  // frame — the diagnostic runs per-service, so only a `level:'frame'` block is valid.
  'env_test_not_a_frame',
  // The self-test was requested for a service with no ephemeral-environment provisioning
  // configured (`infraless` / none) — there is nothing to exercise.
  'env_test_infraless',
  // The self-test's service has a provision type but no workspace handler resolves for it yet,
  // so provisioning can't run — the SPA steers the user to configure the environment handler.
  'env_test_not_provisionable',
  // The self-test needs a git provider to create/delete its throwaway branch, but the
  // workspace is not connected to one.
  'env_test_no_vcs',
  // The self-test's handler resolves and is structurally configured, but its LIVE connection probe
  // failed — a rejected token, an unreachable endpoint, a project/namespace that does not exist.
  // Raised as a pre-flight BEFORE the throwaway branch is created, carrying the provider's own
  // message so the SPA can word the specific cause. (A MISSING handler is
  // `env_test_not_provisionable`, not this.)
  'env_test_connection_failed',
  // Opt-in review-debt friction (soft tier): the workspace has enough tasks parked on human
  // review to cross its warn threshold. Creating a task is refused UNLESS the request carries
  // `acknowledgeReviewDebt: true`; the SPA turns this into a confirm-to-proceed dialog listing
  // exactly what is waiting, then retries with the flag. (See `review-debt-friction.md`.)
  'review_debt_warn',
  // Opt-in review-debt friction (hard tier): too many tasks are parked on human review (by count
  // or by how long the oldest has waited), so task creation is refused outright until the review
  // queue is worked down — an acknowledgement cannot tunnel through this.
  'review_debt_blocked',
  // Two people edited the same agent's system prompt at once. The prompt log is append-only and
  // the next revision number comes from a read, so the second save collides rather than being
  // merged last-write-wins — the SPA reloads the log and asks the user to re-apply their edit on
  // top of what landed, instead of silently discarding one of the two prompts.
  'prompt_revision_conflict',
  // The three ways a recurring SCHEDULE blocks a pipeline edit. Each fire resolves its pipeline by
  // id and reads its config, so all three would break the schedule silently — nobody is watching a
  // recurring run that simply stops producing work, which is why they are refusals and not warnings.
  // The remedy differs per case, hence three reasons rather than one:
  //  - `pipeline_schedule_attached` — DELETING a pipeline a schedule still points at (every future
  //    fire would fail to resolve it). Detach the schedule, then delete.
  'pipeline_schedule_attached',
  //  - `pipeline_schedule_requires_recurring` — making a pipeline one-off-only while a schedule
  //    still points at it (each fire throws at origin='recurring').
  'pipeline_schedule_requires_recurring',
  //  - `pipeline_schedule_intake_unconfigured` — enabling a `bug-intake` step on a pipeline whose
  //    attached schedule carries no `issueIntake` config, so every fire would no-op. Configure
  //    issue intake ON THE SCHEDULE first — the remedy is a different panel from the two above.
  'pipeline_schedule_intake_unconfigured',
  // A foundational service with this id is already registered at the addressed scope. The SPA
  // steers the user to the existing entry (edit it) rather than to a retry with a new id: the
  // id IS what an Architect names in its design, so two rows competing for one id is exactly
  // the ambiguity the catalog exists to prevent.
  'foundational_service_exists',
  // A binary-generating step's (`binary-output` trait) selected foundational service does not
  // resolve against the workspace's catalog — the id is unknown
  // (`details.problem: 'unknown_service'`), or the selected STORAGE service does not carry the
  // `asset-storage` capability tag (`details.problem: 'not_storage_capable'`).
  // `details.serviceId` names the offender. The catalog can change after the pipeline was
  // saved, which is why run admission re-validates the selection every start/retry/restart.
  // (A step MISSING its selection entirely is a structural pipeline fault, refused as a 422 at
  // save and start by `assertValidBinaryOutputSteps` — the skill-step precedent.)
  'binary_output_service_invalid',
  // A binary-generating step's selected GENERATIVE INTEGRATION does not resolve — the id is not
  // one this deployment registers on its `BinaryGeneratorRegistry`
  // (`details.problem: 'unknown_generator'`, `details.generatorId` names it), or no selected
  // integration produces a content type the step declares it delivers
  // (`details.problem: 'modality_uncovered'`, `details.modality` names it).
  //
  // Deliberately NOT folded into `binary_output_service_invalid`, which is about the same step:
  // that one resolves against the workspace's CATALOG and is fixed in the app, while this one
  // resolves against the deployment's own CODE and is fixed in a build. One reason would send
  // half the readers to the wrong place. Re-checked at every start/retry/restart, since a
  // deployment can be rolled back under a saved pipeline.
  'binary_output_generator_invalid',
  // A tier asked to SUPPRESS a foundational service that it already owns a row for at its own
  // tier. Suppression writes a tombstone so the INHERITED service of that id (an account
  // service for a board, a deployment `builtin` for either) loses the merge; against the
  // tier's own registration it would be an obscure spelling of "delete", and the two are not
  // interchangeable — a delete drops the authored description and contracts, a suppression
  // drops nothing. The SPA steers to the delete action instead.
  'foundational_service_not_inherited',
  // A tracker ticket was named as the source of a NEW task while it is already linked to an
  // existing one. An issue carries a single `linkedBlockId`, so proceeding would silently
  // re-point it and strip the first task of the very context it was created with.
  // `details.taskId` names the task that holds the link, which is also what makes the refusal
  // useful to a headless integration: a redelivered webhook reads it as "already filed" and
  // follows the existing task instead of filing a duplicate.
  'ticket_already_linked',
  // A caller tried to resolve a run's PRE-DISPATCH INPUT GATE that is not (or is no longer) parked
  // on it: the gate passed, the workspace has it off, or another surface already answered it.
  // The remedy is "nothing to do here": the SPA refreshes the run rather than re-offering a
  // decision that has already been taken.
  'input_gate_not_parked',
  // The OPPOSITE fact, and deliberately its own reason rather than a second use of the one above.
  // The run IS parked on the input gate and the caller tried to answer it through the GENERIC
  // approval rail. The gate parks whatever step 0 happens to be, so a generic approve would mark
  // the run's first working step done and skip the work the run exists to do.
  //
  // One reason for both states would have to describe them with one string, and the two need
  // opposite responses: "already answered, refresh" against "still waiting, answer it over there".
  // Copy that fits the first tells whoever is looking at a live park that there is nothing to
  // answer, which is the very thing they are staring at the remedy for.
  'input_gate_parked',
] as const

export type ConflictReason = (typeof CONFLICT_REASONS)[number]

/**
 * Machine-readable reasons behind a 503 (`error.details.reason` on an `UnavailableError`), for
 * the ones a USER can reach — the SPA keys an exhaustive `Record<UnavailableReason, …>` of
 * message keys off this, exactly as it does for {@link CONFLICT_REASONS}.
 *
 * A 503 without a reason is left to the status class's generic copy, and that copy has to say
 * something — today "this deployment has not configured the capability this action needs". For
 * an outage that is the WRONG claim, and precisely the misattribution the reasons below exist to
 * prevent one layer down: a node whose mothership is unreachable would tell an operator their
 * deployment is misconfigured, sending them to a build with nothing wrong in it. So a 503 whose
 * cause is "reachable, just not right now" belongs here rather than on the generic fallback.
 *
 *  - `binary_generators_unreachable`   — the deployment's generative binary integrations could
 *                                        not be read. On a mothership-mode node they are read
 *                                        from the mothership, and run admission refuses rather
 *                                        than resolving a step's `generatorIds` against an
 *                                        unknown set. Retryable; nothing is misconfigured.
 *  - `foundational_builtins_unreachable` — the same shape for the deployment's `builtin`
 *                                        foundational-services tier.
 */
export const UNAVAILABLE_REASONS = [
  'binary_generators_unreachable',
  'foundational_builtins_unreachable',
] as const

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]

/**
 * Machine-readable reasons a `review` task's target pull request is refused at creation
 * (`error.details.reason` on the 422). Same contract as {@link CONFLICT_REASONS} — the code is
 * the source of truth and the SPA keys an exhaustive `Record<ReviewTargetReason, …>` of message
 * keys off it, so adding a reason without wording trips the frontend typecheck.
 *
 *  - `review_pr_not_found`      — the provider positively reports no such pull request on the
 *                                 service's linked repository (its own 404, never an outage).
 *  - `review_pr_repo_mismatch`  — the pasted link belongs to a DIFFERENT repository than the one
 *                                 this service reviews. The reviewer fetches the PR by number
 *                                 from the linked repo (ADR 0023), so accepting it would review
 *                                 whatever PR happens to carry that number there. `details`
 *                                 carries `expected` (`owner/repo`).
 */
export const REVIEW_TARGET_REASONS = ['review_pr_not_found', 'review_pr_repo_mismatch'] as const

export type ReviewTargetReason = (typeof REVIEW_TARGET_REASONS)[number]
