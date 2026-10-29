// ---------------------------------------------------------------------------
// Translated copy and the one-click fix per 409 conflict reason. Moved out of
// `usePipelineErrorToast` so every surface that states the same refusal reads one table: the
// toast, and the failure block on a run that a conflict stopped before it started (a `preflight`
// failure carries the conflict's `details.reason`). Plain data plus a lookup, so a util and a
// unit test can import it without the composable's store and toast handles.
// ---------------------------------------------------------------------------

import type { ConflictReason } from '@cat-factory/contracts'
import {
  BINARY_STORAGE_FIX,
  ENVIRONMENTS_FIX,
  MODEL_CONFIG_FIX,
  MODEL_SETUP_FIX,
  RUNNER_POOL_FIX,
  SOURCE_CONTROL_FIX,
  type SetupFix,
} from '~/utils/setupFixes'

/** An optional one-click "jump to the panel that fixes it" affordance on a conflict toast. */
export interface ConflictAction {
  /** i18n message key for the button label (a static literal so tier-1 typed keys see it). */
  labelKey: string
  icon: string
  /**
   * The gap's owner and the screen that closes it. A toast gates it on who is asking
   * (`gateSetupFix`), so only a caller who can save gets the button.
   */
  fix: SetupFix
}

/** Per-reason toast copy: a translated title + description, and optionally a jump action. */
export interface ConflictInfo {
  titleKey: string
  descriptionKey: string
  action?: ConflictAction
}

/**
 * Per-reason toast copy, keyed off the kernel/contracts `ConflictReason`. Being an EXHAUSTIVE
 * `Record` over the union is the real drift guard: a new backend conflict reason fails THIS
 * typecheck until it is mapped here (title + description). (The typed-message-keys feature can't
 * see the `t()` lookup because the key is resolved at runtime via this map, not written as a
 * literal, so the exhaustiveness of the map, not `t()`, is what makes a missing reason a build
 * error.) The reasons with BESPOKE handling in `composables/pipelineErrorToast/bespokeConflicts.ts` (a runtime-interpolated body + a "configure X"
 * action + their own key namespace) are excluded, since none reaches this generic lookup:
 * `providers_unconfigured`, `binary_storage_unconfigured`, and the deployment-environment trio
 * `provision_type_unhandled` / `deployer_service_provisioning_incomplete` /
 * `deployer_connection_test_failed`.
 *
 * G1 (error-message coverage): before this, only a title was mapped and the description fell back
 * to the raw, untranslated backend `message`. Every reason now carries a translated `description`
 * (remedy prose), and the ones a UI panel can fix carry a `run` deep-link: the same shape as the
 * bespoke conflicts, but data-driven instead of one `if` per reason.
 */
export type BespokeConflictReason =
  | 'providers_unconfigured'
  | 'binary_storage_unconfigured'
  | 'provision_type_unhandled'
  | 'deployer_service_provisioning_incomplete'
  | 'deployer_connection_test_failed'

export const CONFLICT_INFO: Record<Exclude<ConflictReason, BespokeConflictReason>, ConflictInfo> = {
  dependencies_unmet: {
    titleKey: 'errors.conflict.title.dependencies_unmet',
    descriptionKey: 'errors.conflict.description.dependencies_unmet',
  },
  // A monorepo bootstrap's review was submitted for a run that has since moved on: the fix is
  // to look at where the run actually is, not to retry.
  bootstrap_not_awaiting_review: {
    titleKey: 'errors.conflict.title.bootstrap_not_awaiting_review',
    descriptionKey: 'errors.conflict.description.bootstrap_not_awaiting_review',
  },
  adoption_plan_unavailable: {
    titleKey: 'errors.conflict.title.adoption_plan_unavailable',
    descriptionKey: 'errors.conflict.description.adoption_plan_unavailable',
  },
  // The remedy is a different DIRECTORY, not a different repository or a retry.
  monorepo_directory_taken: {
    titleKey: 'errors.conflict.title.monorepo_directory_taken',
    descriptionKey: 'errors.conflict.description.monorepo_directory_taken',
  },
  input_gate_not_parked: {
    titleKey: 'errors.conflict.title.input_gate_not_parked',
    descriptionKey: 'errors.conflict.description.input_gate_not_parked',
  },
  input_gate_parked: {
    titleKey: 'errors.conflict.title.input_gate_parked',
    descriptionKey: 'errors.conflict.description.input_gate_parked',
  },
  // The two halves of "this policy is not yours to change" (ADR 0055). They get opposite copy on
  // purpose: the first sends the reader to the clone action, the second to the delete, and one
  // shared string could only describe whichever case the reader was not in.
  risk_policy_inherited: {
    titleKey: 'errors.conflict.title.risk_policy_inherited',
    descriptionKey: 'errors.conflict.description.risk_policy_inherited',
  },
  risk_policy_not_inherited: {
    titleKey: 'errors.conflict.title.risk_policy_not_inherited',
    descriptionKey: 'errors.conflict.description.risk_policy_not_inherited',
  },
  // Raised only by the public `/api/v1/kaizen/entries/:id/acknowledge` route today, so no SPA
  // action reaches it. Mapped all the same, because the map is exhaustive over the wire
  // vocabulary rather than over the subset this app happens to trigger: the day a Kaizen screen
  // grows an acknowledge button, the copy is already here rather than an untranslated fallback.
  kaizen_entry_not_settled: {
    titleKey: 'errors.conflict.title.kaizen_entry_not_settled',
    descriptionKey: 'errors.conflict.description.kaizen_entry_not_settled',
  },
  // The five bug-fishing-expedition refusals. `no_expedition` / `expedition_settled` /
  // `not_awaiting_triage` are the three "you are not where you think you are" causes, and they
  // take different fixes: the run never had an expedition, the run has moved past the one it had,
  // or the expedition is alive but not parked (so a triage cannot be finished yet).
  // `already_addressed` names findings that already have a fix task, so a second request cannot
  // double-spawn; `no_host_frame` is a board-shape problem the operator fixes by putting the
  // expedition under a service.
  no_expedition: {
    titleKey: 'errors.conflict.title.no_expedition',
    descriptionKey: 'errors.conflict.description.no_expedition',
  },
  expedition_settled: {
    titleKey: 'errors.conflict.title.expedition_settled',
    descriptionKey: 'errors.conflict.description.expedition_settled',
  },
  not_awaiting_triage: {
    titleKey: 'errors.conflict.title.not_awaiting_triage',
    descriptionKey: 'errors.conflict.description.not_awaiting_triage',
  },
  already_addressed: {
    titleKey: 'errors.conflict.title.already_addressed',
    descriptionKey: 'errors.conflict.description.already_addressed',
  },
  no_host_frame: {
    titleKey: 'errors.conflict.title.no_host_frame',
    descriptionKey: 'errors.conflict.description.no_host_frame',
  },
  delegated_executor_unwired: {
    titleKey: 'errors.conflict.title.delegated_executor_unwired',
    descriptionKey: 'errors.conflict.description.delegated_executor_unwired',
  },
  // The two conditions that are NOT about a missing registration. They had borrowed the reason
  // above, whose copy sends an operator to register an executor that is registered and fine.
  delegated_step_async_only: {
    titleKey: 'errors.conflict.title.delegated_step_async_only',
    descriptionKey: 'errors.conflict.description.delegated_step_async_only',
  },
  delegated_claim_missing: {
    titleKey: 'errors.conflict.title.delegated_claim_missing',
    descriptionKey: 'errors.conflict.description.delegated_claim_missing',
  },
  thread_busy: {
    titleKey: 'errors.conflict.title.thread_busy',
    descriptionKey: 'errors.conflict.description.thread_busy',
  },
  draft_conflict: {
    titleKey: 'errors.conflict.title.draft_conflict',
    descriptionKey: 'errors.conflict.description.draft_conflict',
  },
  session_stale: {
    titleKey: 'errors.conflict.title.session_stale',
    descriptionKey: 'errors.conflict.description.session_stale',
  },
  cursor_expired: {
    titleKey: 'errors.conflict.title.cursor_expired',
    descriptionKey: 'errors.conflict.description.cursor_expired',
  },
  refined_requirements_unavailable: {
    titleKey: 'errors.conflict.title.refined_requirements_unavailable',
    descriptionKey: 'errors.conflict.description.refined_requirements_unavailable',
  },
  no_linked_issues: {
    titleKey: 'errors.conflict.title.no_linked_issues',
    descriptionKey: 'errors.conflict.description.no_linked_issues',
  },
  task_limit_reached: {
    titleKey: 'errors.conflict.title.task_limit_reached',
    descriptionKey: 'errors.conflict.description.task_limit_reached',
  },
  webhook_limit_reached: {
    titleKey: 'errors.conflict.title.webhook_limit_reached',
    descriptionKey: 'errors.conflict.description.webhook_limit_reached',
  },
  tester_infra_unsupported: {
    titleKey: 'errors.conflict.title.tester_infra_unsupported',
    descriptionKey: 'errors.conflict.description.tester_infra_unsupported',
  },
  agent_backend_unconfigured: {
    titleKey: 'errors.conflict.title.agent_backend_unconfigured',
    descriptionKey: 'errors.conflict.description.agent_backend_unconfigured',
    action: {
      labelKey: 'errors.conflict.action.configureRunnerPool',
      icon: 'i-lucide-server',
      fix: RUNNER_POOL_FIX,
    },
  },
  run_not_retryable: {
    titleKey: 'errors.conflict.title.run_not_retryable',
    descriptionKey: 'errors.conflict.description.run_not_retryable',
  },
  no_pr_to_merge: {
    titleKey: 'errors.conflict.title.no_pr_to_merge',
    descriptionKey: 'errors.conflict.description.no_pr_to_merge',
  },
  dry_run_not_mergeable: {
    titleKey: 'errors.conflict.title.dry_run_not_mergeable',
    descriptionKey: 'errors.conflict.description.dry_run_not_mergeable',
  },
  submission_not_allowed: {
    titleKey: 'errors.conflict.title.submission_not_allowed',
    descriptionKey: 'errors.conflict.description.submission_not_allowed',
  },
  github_not_connected: {
    titleKey: 'errors.conflict.title.github_not_connected',
    descriptionKey: 'errors.conflict.description.github_not_connected',
    action: {
      labelKey: 'errors.conflict.action.connectGitHub',
      icon: 'i-lucide-github',
      fix: SOURCE_CONTROL_FIX,
    },
  },
  bootstrap_not_retryable: {
    titleKey: 'errors.conflict.title.bootstrap_not_retryable',
    descriptionKey: 'errors.conflict.description.bootstrap_not_retryable',
  },
  bootstrap_reference_missing: {
    titleKey: 'errors.conflict.title.bootstrap_reference_missing',
    descriptionKey: 'errors.conflict.description.bootstrap_reference_missing',
  },
  preset_unsatisfiable: {
    titleKey: 'errors.conflict.title.preset_unsatisfiable',
    descriptionKey: 'errors.conflict.description.preset_unsatisfiable',
    action: {
      labelKey: 'errors.conflict.action.chooseModel',
      icon: 'i-lucide-cpu',
      fix: MODEL_CONFIG_FIX,
    },
  },
  visual_pipeline_no_frontend: {
    titleKey: 'errors.conflict.title.visual_pipeline_no_frontend',
    descriptionKey: 'errors.conflict.description.visual_pipeline_no_frontend',
  },
  model_policy_blocked: {
    titleKey: 'errors.conflict.title.model_policy_blocked',
    descriptionKey: 'errors.conflict.description.model_policy_blocked',
    action: {
      labelKey: 'errors.conflict.action.chooseModel',
      icon: 'i-lucide-cpu',
      fix: MODEL_CONFIG_FIX,
    },
  },
  model_policy_unsupported: {
    titleKey: 'errors.conflict.title.model_policy_unsupported',
    descriptionKey: 'errors.conflict.description.model_policy_unsupported',
  },
  deployer_required_before_tester: {
    titleKey: 'errors.conflict.title.deployer_required_before_tester',
    descriptionKey: 'errors.conflict.description.deployer_required_before_tester',
  },
  env_test_not_a_frame: {
    titleKey: 'errors.conflict.title.env_test_not_a_frame',
    descriptionKey: 'errors.conflict.description.env_test_not_a_frame',
  },
  env_test_infraless: {
    titleKey: 'errors.conflict.title.env_test_infraless',
    descriptionKey: 'errors.conflict.description.env_test_infraless',
  },
  env_test_not_provisionable: {
    titleKey: 'errors.conflict.title.env_test_not_provisionable',
    descriptionKey: 'errors.conflict.description.env_test_not_provisionable',
    action: {
      labelKey: 'errors.conflict.action.configureInfrastructure',
      icon: 'i-lucide-settings',
      fix: ENVIRONMENTS_FIX,
    },
  },
  env_test_no_vcs: {
    titleKey: 'errors.conflict.title.env_test_no_vcs',
    descriptionKey: 'errors.conflict.description.env_test_no_vcs',
    action: {
      labelKey: 'errors.conflict.action.connectGitHub',
      icon: 'i-lucide-github',
      fix: SOURCE_CONTROL_FIX,
    },
  },
  env_test_connection_failed: {
    titleKey: 'errors.conflict.title.env_test_connection_failed',
    descriptionKey: 'errors.conflict.description.env_test_connection_failed',
    action: {
      labelKey: 'errors.conflict.action.configureInfrastructure',
      icon: 'i-lucide-settings',
      fix: ENVIRONMENTS_FIX,
    },
  },
  // An agent dry run on a deployment that cannot drive one. No ACTION: the gap is a container
  // runner, a proxyable model or a repository seam, none of which a user can wire from the SPA.
  // Offering a settings jump here would send them somewhere that cannot fix it.
  env_test_probe_unavailable: {
    titleKey: 'errors.conflict.title.env_test_probe_unavailable',
    descriptionKey: 'errors.conflict.description.env_test_probe_unavailable',
  },
  // The frame's RESOLVED model cannot be dispatched: a provider the LLM proxy cannot serve, or a
  // subscription-only model with no connected credential. Distinct from the reason above, whose
  // gap is a container prerequisite: this deployment is wired and the workspace's own model preset
  // names something unrunnable, so the remedy is in the model settings and the jump is worth
  // offering. The specific cause rides `details.modelIssue`, which the funnel surfaces as detail.
  env_test_probe_model_unavailable: {
    titleKey: 'errors.conflict.title.env_test_probe_model_unavailable',
    descriptionKey: 'errors.conflict.description.env_test_probe_model_unavailable',
  },
  // A second self-test on a frame that already has one running. No ACTION: the remedy is to wait
  // for the run showing in the same panel, or to stop it with the button beside it.
  env_test_already_running: {
    titleKey: 'errors.conflict.title.env_test_already_running',
    descriptionKey: 'errors.conflict.description.env_test_already_running',
  },
  // The workspace is over a spend budget and a dry run is a billable call. No ACTION here either:
  // budgets are an account-level setting, and the provisioning self-test beside it still runs.
  env_test_over_budget: {
    titleKey: 'errors.conflict.title.env_test_over_budget',
    descriptionKey: 'errors.conflict.description.env_test_over_budget',
  },
  // Opt-in review-debt friction. In the normal task-create flow AddTaskModal intercepts these
  // 409s and opens the friction dialog (which can retry with an acknowledgement), so these entries
  // are the last-resort toast fallback for any OTHER caller: a generic, param-free title +
  // description reusing the dialog's own `errors.reviewFriction.*` namespace.
  review_debt_warn: {
    titleKey: 'errors.reviewFriction.warnTitle',
    descriptionKey: 'errors.reviewFriction.warnToast',
  },
  review_debt_blocked: {
    titleKey: 'errors.reviewFriction.blockedTitle',
    descriptionKey: 'errors.reviewFriction.blockedToast',
  },
  // Reachable from this generic lookup only if a prompt save is ever driven from a run-start
  // path; the prompt editor words it itself (it also has to re-seed its textarea from what
  // landed). Mapped regardless: the exhaustive Record is the drift guard, not a hint that
  // every reason arrives here.
  prompt_revision_conflict: {
    titleKey: 'errors.conflict.title.prompt_revision_conflict',
    descriptionKey: 'errors.conflict.description.prompt_revision_conflict',
  },
  // The three ways a recurring SCHEDULE blocks a pipeline edit (delete / make one-off / enable
  // bug-intake). No jump action: a schedule is reached through its own frame's inspector, not from
  // a workspace-level route, so there is no single target to deep-link to, so the description names
  // the remedy instead. What each one must convey is that the fix is on the SCHEDULE and not on the
  // pipeline the user is looking at, which is the part the refusal alone doesn't make obvious.
  pipeline_schedule_attached: {
    titleKey: 'errors.conflict.title.pipeline_schedule_attached',
    descriptionKey: 'errors.conflict.description.pipeline_schedule_attached',
  },
  pipeline_schedule_requires_recurring: {
    titleKey: 'errors.conflict.title.pipeline_schedule_requires_recurring',
    descriptionKey: 'errors.conflict.description.pipeline_schedule_requires_recurring',
  },
  foundational_service_exists: {
    titleKey: 'errors.conflict.title.foundational_service_exists',
    descriptionKey: 'errors.conflict.description.foundational_service_exists',
  },
  binary_output_service_invalid: {
    titleKey: 'errors.conflict.title.binary_output_service_invalid',
    descriptionKey: 'errors.conflict.description.binary_output_service_invalid',
  },
  binary_output_generator_invalid: {
    titleKey: 'errors.conflict.title.binary_output_generator_invalid',
    descriptionKey: 'errors.conflict.description.binary_output_generator_invalid',
  },
  foundational_service_not_inherited: {
    titleKey: 'errors.conflict.title.foundational_service_not_inherited',
    descriptionKey: 'errors.conflict.description.foundational_service_not_inherited',
  },
  pipeline_schedule_intake_unconfigured: {
    titleKey: 'errors.conflict.title.pipeline_schedule_intake_unconfigured',
    descriptionKey: 'errors.conflict.description.pipeline_schedule_intake_unconfigured',
  },
  ticket_already_linked: {
    titleKey: 'errors.conflict.title.ticket_already_linked',
    descriptionKey: 'errors.conflict.description.ticket_already_linked',
  },
  document_already_linked: {
    titleKey: 'errors.conflict.title.document_already_linked',
    descriptionKey: 'errors.conflict.description.document_already_linked',
  },
}

/**
 * The copy and the fix for a conflict reason, or undefined for a reason this table does not map
 * (a bespoke reason, a reason this SPA build has never heard of, or a reason from another error
 * class). The `reason` is a string off the wire, so the lookup asks the table itself rather than
 * casting the string to the union.
 */
export function conflictInfo(reason: string | null | undefined): ConflictInfo | undefined {
  return reason && Object.hasOwn(CONFLICT_INFO, reason)
    ? CONFLICT_INFO[reason as keyof typeof CONFLICT_INFO]
    : undefined
}

/**
 * The two bespoke reasons that a stopped run can carry and that a settings panel fixes. Their
 * toasts interpolate runtime detail (`bespokeConflicts.ts`), which a stored failure does not
 * keep, so a run's failure block uses a fixed cause line. The toast reads the same fix, so the
 * button cannot drift between the two surfaces.
 */
export const BESPOKE_CONFLICT_FIXES = {
  providers_unconfigured: {
    titleKey: 'errors.conflict.providersUnconfigured.title',
    descriptionKey: 'errors.conflict.providersUnconfigured.cause',
    action: {
      labelKey: 'errors.conflict.providersUnconfigured.action',
      icon: 'i-lucide-settings',
      fix: MODEL_SETUP_FIX,
    },
  },
  binary_storage_unconfigured: {
    titleKey: 'errors.conflict.binaryStorageUnconfigured.title',
    descriptionKey: 'errors.conflict.binaryStorageUnconfigured.body',
    action: {
      labelKey: 'errors.conflict.binaryStorageUnconfigured.action',
      icon: 'i-lucide-settings',
      fix: BINARY_STORAGE_FIX,
    },
  },
} satisfies Partial<Record<BespokeConflictReason, ConflictInfo>>

/**
 * The copy and the fix for any refusal reason a failure can carry: the mapped conflicts, then
 * the bespoke ones with a fixed cause line. Undefined for a reason neither table maps.
 */
export function refusalCopy(reason: string | null | undefined): ConflictInfo | undefined {
  if (!reason) return undefined
  if (Object.hasOwn(BESPOKE_CONFLICT_FIXES, reason)) {
    return BESPOKE_CONFLICT_FIXES[reason as keyof typeof BESPOKE_CONFLICT_FIXES]
  }
  return conflictInfo(reason)
}
