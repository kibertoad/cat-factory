import type { EnvironmentAddress, EnvironmentRouteProof } from '@cat-factory/contracts'
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

/**
 * What the platform knows about REACHING this environment: the addresses its provider stated to
 * dial, and what dialling them proved.
 *
 * In the bundle because it is the one evidence source carrying its OWN timestamp for something
 * the platform did, and an ordering claim made without it is a claim made against data the
 * platform held. The failure that filed this said the reachability verdict "settled roughly at the
 * moment of the create request", with no wait; `proof.checkedAt` sat in the same stored value as
 * the attempt list the same investigation quoted correctly, and it read 4m18s after the create.
 * The proof is therefore FOLDED into {@link EnvironmentEvidenceBundle.timeline} as well as
 * carried here, so the ordering is read off one sorted list rather than reconciled by hand.
 *
 * It is also where the most determinate cause of an unreachable environment lives: an empty
 * `candidates` beside a `not_reached` proof means nothing but the environment's own name was ever
 * available to try. See `determinateRouteCause`.
 */
export interface EnvironmentRouteEvidence {
  /**
   * The addresses the provider stated carry traffic for the URL's host, in ITS order. Empty means
   * it stated none, so the URL's own name was the only target that existed.
   *
   * Provider-authored, so already redacted and bounded by whoever gathered this bundle, exactly
   * like {@link EnvironmentTimelineEntry.detail} and a diagnosis's facts. Anything cut is named in
   * {@link EnvironmentEvidenceBundle.evidenceCaps}; a reader RENDERS these, it does not re-scrub
   * them.
   */
  candidates: readonly EnvironmentAddress[]
  /**
   * What dialling established, or null when nothing has dialled this environment. Its attempts'
   * `target` and `detail` are redacted and capped on the same terms as `candidates` above.
   */
  proof: EnvironmentRouteProof | null
  /**
   * Why there is neither, when the stored value could not be READ. Its own member because an
   * unparseable blob and a provider that stated no addresses are opposite facts, and the second is
   * a determinate cause this bundle is about to hand a reader.
   */
  unreadable?: string
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
  /**
   * The run's own provisioning attempts for this environment, oldest first, with everything else
   * the platform has a timestamp for folded in: the record's own dates, the route proof, and the
   * marker recording that status polls happened at all.
   *
   * ONE derived list rather than a log the reader has to reconcile against separate fields. An
   * ordering claim contradicted by a timestamp in the same bundle is the defect this shape exists
   * to make structurally hard to state.
   */
  timeline: EnvironmentTimelineEntry[]
  /** What the platform knows about reaching it. See {@link EnvironmentRouteEvidence}. */
  route: EnvironmentRouteEvidence
  /** The provider's own account, when it implements the diagnostics capability. */
  diagnosis?: EnvironmentDiagnosis
  /** Why there is none: the provider offers no diagnostics, or the describe call failed. */
  diagnosisUnavailable?: string
  /**
   * What the PLATFORM cut out of this bundle before handing it on, one sentence each.
   *
   * Its own member rather than extra `diagnosis.gaps`, because a gap is the PROVIDER's list of
   * reads it could not make: attributing a cap to the provider would have the investigator reason
   * about a control plane that in fact answered fine. Absent ⇒ nothing was cut, which is a
   * different fact from a cut nobody recorded (CLAUDE.md's "every cap records what it dropped").
   */
  evidenceCaps?: string[]
  /** The failure the run recorded, which is what the investigation is about. */
  failure: EnvironmentFailureFacts
}

/**
 * What the readiness wait contributed to a failure, as three distinct facts rather than a
 * nullable duration.
 *
 * A missing `waitedMs` is not one story: the provider may have DECLARED the environment failed
 * (so there was a verdict and nothing waited), or the failure may have happened before any
 * readiness judgement existed (a deploy container shut down mid-run, a provision call that threw),
 * in which case the wait says nothing about it at all. Collapsed into one absence, the second
 * rendered as the first, telling an investigator there had been a live verdict on a deploy that
 * had in fact run for twenty minutes and produced none.
 */
export type EnvironmentReadinessWaitKind = 'waited' | 'verdict_without_wait' | 'not_reached'

/** The failure the run recorded, which is what an investigation is about. */
export interface EnvironmentFailureFacts {
  /** The verbatim provisioning error. */
  error: string
  /** The classified cause, when the provider stated one. */
  reason?: string
  /** Which readiness story this failure has. See {@link EnvironmentReadinessWaitKind}. */
  readinessWait: EnvironmentReadinessWaitKind
  /** How long the readiness wait ran before it was given up on; set iff `readinessWait` is `waited`. */
  waitedMs?: number
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
