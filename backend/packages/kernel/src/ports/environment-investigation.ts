import type { Block } from '../domain/types.js'
import type { EnvironmentDiagnosis } from './environment-diagnostics.js'

// ---------------------------------------------------------------------------
// The environment investigation's two seams: the EVIDENCE the platform gathers about an
// environment that never became usable, and the JUDGEMENT seam that reads it.
//
// The gathering is deterministic (registry reads, the provision-field bag, the run's own
// provisioning log, and the provider's optional describe). The JUDGEMENT (which layer is at
// fault and what, if anything, is worth doing) is the one part that needs a model, so it sits
// behind this port exactly as the bug hunt's ranking sits behind `BugHuntAssessor` and a judge
// step's verdict behind `JudgeAssessor`.
//
// Injecting it keeps the engine's loop model-neutral: the facades wire the inline implementation
// from the model dependencies they already supply, and a conformance harness swaps in a
// deterministic verdict through the same seam.
// ---------------------------------------------------------------------------

/**
 * The environment as the PLATFORM's own registry records it: the four fields a consuming step is
 * handed today, plus the two that say which handler stood it up.
 *
 * Its whole job in the bundle is to be CONTRADICTABLE. The failure this feature was filed for had
 * a record saying `ready` with an empty `lastError` sitting beside a provider that was reporting
 * an offline VM, and an investigator that is shown only one of those has nothing to reason about.
 */
export interface EnvironmentRecordFacts {
  id: string | null
  status: string
  url: string | null
  expiresAt: number | null
  lastError: string | null
  provisionType: string | null
  engine: string | null
}

/** One dated thing that happened to this environment, oldest first. */
export interface EnvironmentTimelineEntry {
  /** Epoch ms, or null for a fact with no timestamp of its own. */
  at: number | null
  /** What happened (`provision failed`, `readiness ceiling expired`, …). */
  label: string
  /** The verbatim detail, already redacted. */
  detail?: string
}

/**
 * Everything the platform can say about a failed environment, gathered before anything is asked
 * of a model.
 *
 * Every member is present or explicitly absent, never silently omitted: `diagnosisUnavailable`
 * exists because a bundle with no `diagnosis` reads exactly like one whose provider was asked and
 * found nothing wrong, and those are opposite facts.
 */
export interface EnvironmentEvidenceBundle {
  environment: EnvironmentRecordFacts
  /**
   * The WHOLE provision-field bag, redacted: every field the provider's own response mapping
   * captured, not the four the agent-context projection keeps.
   *
   * This is where most of the evidence already was. The bag is persisted encrypted because it is
   * teardown state, and nothing ever read it for any other purpose, so an adapter recording its
   * balancer health, its DNS resolution and a reachability sentence on every poll was writing them
   * into a field no reader existed for.
   */
  provisionFields: Record<string, string>
  /** The run's own provisioning attempts for this environment, oldest first. */
  timeline: EnvironmentTimelineEntry[]
  /** The provider's own account, when it implements the diagnostics capability. */
  diagnosis?: EnvironmentDiagnosis
  /** Why there is none: the provider offers no diagnostics, or the describe call failed. */
  diagnosisUnavailable?: string
  /** The failure the run recorded, which is what the investigation is about. */
  failure: {
    /** The verbatim provisioning error. */
    error: string
    /** The classified cause, when the provider stated one. */
    reason?: string
    /** How long the readiness wait ran before it was given up on, when there was one. */
    waitedMs?: number
  }
}

/** The subject of one investigation: the evidence, plus what the engine will honour if asked. */
export interface EnvironmentInvestigationSubject {
  workspaceId: string
  /**
   * The run this investigation belongs to. Carried explicitly rather than left to the credential
   * scope's fallback, because an inline call on the run path whose row is filed without it is IN
   * the telemetry store and ABSENT from every run-scoped read, which renders as a step that spent
   * nothing.
   */
  executionId: string
  /** The task block, for model resolution (its pin, its preset). */
  block: Block
  evidence: EnvironmentEvidenceBundle
  /**
   * The remediation actions the engine will actually run THIS round, already narrowed by the
   * step's configuration, the remaining budget and the provider's declared support.
   *
   * Passed in rather than left for the model to infer, because a verdict asking for something the
   * engine then refuses is the worst of both: an operator reads a remedy that was never tried, and
   * the round is spent. `stop` is always among them.
   */
  offeredActions: readonly string[]
}

export interface EnvironmentInvestigator {
  /** Whether an investigation can run (a model provider AND a routing default are wired). */
  readonly enabled: boolean
  /**
   * Investigate one failed environment. Returns the RAW extracted JSON value plus the model that
   * produced it. The caller owns the shape
   * (`coerceEnvironmentInvestigationVerdict`), mirroring `JudgeAssessor.assess`, so a model that
   * invents a fault layer or a remediation cannot reach the domain unvalidated.
   *
   * Throws on an unresolved model, a failed generation, or a reply carrying no JSON. The engine
   * records the round as FAILED and falls through to the ordinary terminal failure: an
   * investigation that could not be read must never be presented as a clean bill of health, and
   * must never be able to fail a run on its own either.
   */
  investigate(
    subject: EnvironmentInvestigationSubject,
  ): Promise<{ verdict: unknown; model: string }>
}
