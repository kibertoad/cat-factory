import type { EnvironmentStatusRequest } from './environment-provider.js'

// ---------------------------------------------------------------------------
// The provider's OPTIONAL diagnostic + remediation capability: what it can say about an
// environment beyond "how is it doing", and what it will do about one that is broken.
//
// `status()` answers ONE question and answers it in one word, because that is what the readiness
// judgement needs. Every provider therefore reduces a rich control-plane answer to a member of
// `EnvironmentStatus` and throws the rest away, including, in the failure this port was written
// for, a VM reported `offline` and two load balancers reported unhealthy underneath an
// environment the same response called `online`. Two fields nobody was reading already
// contradicted the one everybody was.
//
// So this is a SEPARATE capability rather than a richer `status()`, for the reason `confirmTeardown`
// is: a method meant for one question gives incidental answers to another, and a provider that
// cannot answer the new question must be able to SAY so rather than have an answer inferred from a
// call meant for something else. Absent ⇒ the platform investigates on the evidence it holds
// itself (the environment record, the whole provision-field bag, the run's own timeline), which is
// byte-for-byte what it would have had anyway.
// ---------------------------------------------------------------------------

/**
 * One named fact the provider read off its own control plane.
 *
 * A `{ key, value }` pair with an explicit `healthy` verdict rather than a prose sentence,
 * because the reader is both a model and a human and the pair is what makes a CONTRADICTION
 * visible: `environment.status=online` beside `jobs[0].vm.status=offline` is an argument, and
 * "the environment is online but the VM is offline" is a claim someone already made.
 */
export interface EnvironmentDiagnosticFact {
  /** Dotted path into the provider's own vocabulary (`jobs[0].vm.status`), not ours. */
  key: string
  /** The value as the provider reported it, already stringified. */
  value: string
  /**
   * The provider's verdict on this fact where it has one: `false` marks something it considers
   * wrong. `undefined` means the provider offers no judgement, which is NOT the same as healthy
   * and must not be rendered as one.
   */
  healthy?: boolean
}

/**
 * A log excerpt the provider could fetch, already capped and redacted BY THE PROVIDER: it is the
 * only party that knows which of its own fields carry credentials, and the excerpt reaches a model
 * prompt.
 */
export interface EnvironmentDiagnosticLog {
  /** What produced it (`deploy-job/build`, `pod/api-7d9`, …). */
  source: string
  /** The excerpt. Capped by the provider; the caller states the cap it applies on top. */
  text: string
  /**
   * Whether `text` is the TAIL of a longer log rather than the whole of it. Stated because a
   * reader who assumes a prefix would conclude the rest was never produced, and a reader who
   * assumes a tail would conclude the start was hidden. See CLAUDE.md's cap rule.
   */
  truncated?: boolean
}

/**
 * A read the provider COULD NOT make, named rather than omitted.
 *
 * The whole point of the degrade-loudly rule: a diagnosis missing its log section reads exactly
 * like one whose logs were clean, and an investigator that cannot tell those apart concludes the
 * workload started fine. `permanent` separates "this deployment's credentials will never be
 * allowed to read pod logs" from "the apiserver timed out", which want opposite reactions.
 */
export interface EnvironmentDiagnosticGap {
  /** What was attempted, in the provider's own terms (`pod logs`, `deploy job history`). */
  read: string
  /** Why it could not be done, safe to show an operator. */
  reason: string
  /** True when re-asking will answer identically forever (a missing grant, an absent endpoint). */
  permanent?: boolean
}

/** Everything a provider can say about an environment when asked to look properly. */
export interface EnvironmentDiagnosis {
  /** Named control-plane facts. Empty is legitimate; the gaps say whether that is a finding. */
  facts: EnvironmentDiagnosticFact[]
  /** Log excerpts, when the provider can fetch any. */
  logs?: EnvironmentDiagnosticLog[]
  /** Reads that could not be made. See {@link EnvironmentDiagnosticGap}. */
  gaps?: EnvironmentDiagnosticGap[]
}

/**
 * The remediations a provider will actually perform. Only `restart` needs the provider at all:
 * standing an environment up again and tearing it down are `EnvironmentProvider` methods every
 * provider already has, and the engine drives those itself (see contracts'
 * `REMEDIATION_NEEDS_PROVIDER_SUPPORT`, which is the one place that division is recorded).
 *
 * A union of one today rather than a bare `'restart'`, so the second member is an addition here
 * and not a re-typing of the whole capability.
 */
export type ProviderRemediationAction = 'restart'

/** Ask a provider to remediate an environment in place. */
export interface EnvironmentRemediationRequest extends EnvironmentStatusRequest {
  action: ProviderRemediationAction
}

/**
 * What the provider did. `applied: false` is an ordinary answer, not an error: a provider asked to
 * restart a workload it cannot find has nothing to do, and reporting that as a success would make
 * the engine re-probe an environment nothing touched and read the unchanged verdict as "the
 * remedy did not work".
 */
export interface EnvironmentRemediationOutcome {
  applied: boolean
  /** What was done, or why nothing was. Surfaced verbatim on the run's record. */
  detail: string
}

/**
 * The provider's diagnostic capability, grouped into ONE optional member so a provider cannot
 * declare the actions it supports without the `describe` that justifies choosing one. That is the same
 * reason `AsyncProvisionCapability` pairs its job-builder with its finalizer.
 */
export interface EnvironmentDiagnosticsCapability {
  /**
   * Read everything this provider can say about the environment. A throw is a diagnosis failure
   * the caller records and continues from: an investigation that could not read the provider is
   * strictly better than none, and must not be able to fail a run on its own.
   */
  describe(req: EnvironmentStatusRequest): Promise<EnvironmentDiagnosis>
  /**
   * The actions this provider will perform. Declared rather than inferred from the presence of
   * {@link remediate}, so a provider can offer diagnosis alone, and so the engine can tell a model
   * what is actually on the table instead of proposing a remedy that silently no-ops. Empty ⇒
   * read-only.
   */
  supportedActions?: readonly ProviderRemediationAction[]
  /**
   * Perform one. Absent ⇒ read-only regardless of {@link supportedActions} (and the engine treats
   * the two identically, so a half-declared capability degrades to diagnosis rather than throwing).
   */
  remediate?(req: EnvironmentRemediationRequest): Promise<EnvironmentRemediationOutcome>
}
