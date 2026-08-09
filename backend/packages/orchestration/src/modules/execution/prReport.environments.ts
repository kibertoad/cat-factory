import type {
  ExecutionInstance,
  PipelineStep,
  PrReportEnvironment,
  PrReportEnvironmentEvidence,
  PrReportEnvironmentTimeline,
  PrReportEvidenceArtifact,
  PrReportTimelineGap,
  PrVerificationReport,
  ProvisioningLogRecord,
} from '@cat-factory/kernel'
import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import {
  declaresRetainedEnvironment,
  isEnvironmentGone,
  runEnvironmentProjections,
  selectDeployStep,
} from '@cat-factory/contracts'
import { isTesterKind } from './ci.logic.js'
import { absentNote, findStep } from './prReport.steps.js'

// ---------------------------------------------------------------------------
// The verification report's TEST ENVIRONMENT LIFECYCLE section: the three-leg proof that the
// change was exercised against real, throwaway infrastructure: the environment came UP,
// evidence was CAPTURED from it while it was live, and it was TORN DOWN again.
//
// Each leg has a different producer, which is why this lived as three disconnected facts
// before: the `deployer` step records per-frame outcomes (`step.deployEnvs`), the provisioning
// event log records WHEN each bring-up and teardown happened, and the tester step records what
// it observed and the screenshots it captured. None of them alone answers the question a
// reviewer actually has, and the platform must not answer it by asking an agent.
//
// Two rules shape everything here:
//
//  - **The verdict is COMPUTED, never asserted.** `proof` is derived from the three legs in
//    code, and every failing condition appends a line to `gaps`, so an `incomplete` proof always
//    names what is missing rather than leaving a reader to diff the sections. An agent's "I
//    tested against the preview environment" is exactly the claim this section replaces.
//
//  - **Absent is not zero, and the CAUSE of an absence is its own fact.** An unwired
//    provisioning log, a read that failed, a read too large to be complete and a run that stood
//    nothing up all produce the same empty timeline and four different facts, so the timeline
//    carries a machine-readable `gap` naming which (`PrReportTimelineGap`) rather than rendering
//    all four as "never torn down". The same rule splits a tester that ran LOCALLY from one that
//    did not SAY where it ran: both are "not evidence about this environment", and only one of
//    them is a decision somebody made.
//
//  - **The teardown leg is accounted by IDENTITY, not by tally.** Comparing a count of teardown
//    rows against a count of ready FRAMES reads as correct until a run replaces an environment
//    mid-flight: the superseded one's teardown then balances the books while its replacement is
//    still standing. So the log's environment ids are followed individually, and `confirmed`
//    means every id this run stood up was reclaimed.
//
// The section lives here rather than in `prReport.logic.ts` because it is the one section
// composed from a source outside the in-memory run (the provisioning log), and because that file
// is the report's shared spine: the file-size budget is a split trigger, not a number to raise.
// ---------------------------------------------------------------------------

/**
 * The provisioning-log fields the lifecycle timeline reads. Deliberately a narrow structural
 * subset of {@link ProvisioningLogRecord}: this module is pure, and the caller has already
 * scoped the query to the run's `environment` rows.
 *
 * `targetId` is the ENVIRONMENT id the attempt acted on, and carrying it is what makes the
 * teardown leg accountable rather than a tally (see the header). It is null on the rows that
 * name no single environment: a provision that failed before a record existed, and a stack
 * recipe's per-STEP rows, neither of which may be read as an environment coming up.
 */
export type ProvisioningLifecycleEvent = Pick<
  ProvisioningLogRecord,
  'operation' | 'outcome' | 'createdAt' | 'targetId' | 'error'
>

/**
 * The run's rows in the provisioning event log, or the reason there are none to fold. A
 * DISCRIMINATED result rather than a nullable list, because the four ways a timeline comes back
 * empty are four different facts and only one of them is a statement about how the deployment is
 * configured (see {@link PrReportTimelineGap}).
 */
export type ProvisioningLifecycleRead =
  | { status: 'read'; events: readonly ProvisioningLifecycleEvent[] }
  | { status: PrReportTimelineGap }

/** The resolved inputs the section needs beyond the run itself. */
export interface PrReportEnvironmentInputs {
  /** The run's ENVIRONMENT rows from the provisioning event log, or why there are none. */
  provisioning: ProvisioningLifecycleRead
  /**
   * Deep link into the run's captured evidence in the app, or null when the deployment
   * configured no public app URL (the report never emits a link to nowhere).
   */
  evidenceUrl: string | null
  /**
   * Builds the direct link to ONE artifact's bytes on the deployment's own blob endpoint, or
   * returns null when no public backend URL is configured.
   *
   * A function rather than pre-built URLs because the composer is what knows which artifacts
   * survived the row cap, and a workspace id threaded through this module for one string would
   * be the only reason it needed one. Absent (a caller that wires no backend URL) ⇒ every row
   * carries its id and no link, which is what the section did before: the id is what an operator
   * greps the store for, so it is never dropped in favour of the link.
   */
  artifactUrl?: (artifactId: string) => string | null
}

/** Cap a list, recording what was dropped in the report's own `truncations` log. */
type Capper = <T>(items: readonly T[], label: string) => T[]

/** Scrub credentials out of an optional free-text value, preserving `null`/`undefined`. */
function scrub(value: string | null | undefined): string | null {
  return value == null ? null : (redactSecrets(value) ?? null)
}

/** The human-readable rendering of each way the timeline can come back empty. */
const TIMELINE_GAP_NOTES: Record<PrReportTimelineGap, string> = {
  unwired:
    'This deployment retains no provisioning event log, so the environment lifecycle could not be dated.',
  unreadable:
    'The provisioning event log could not be read for this run, so the environment lifecycle could not be dated. This is a transient read failure, not a statement that nothing happened.',
  truncated:
    'This run has more provisioning events than one report read may take, so the history is incomplete and the environment lifecycle is not dated from a partial one.',
  not_provisioned:
    'This run has no deployer step, so it stood no environment up and there is no lifecycle to date.',
}

/**
 * The run's environments, as the log accounts for them: which ids came up, and what the LATEST
 * teardown attempt against each one did. Following ids individually is what keeps a run that
 * REPLACED an environment mid-flight from balancing its own books, and latest-attempt-wins is
 * what keeps a retried teardown from being both failed and confirmed.
 */
interface LoggedEnvironments {
  /** Environment ids the log records this run successfully standing up. */
  provisioned: Set<string>
  /**
   * Every id an independent probe CONFIRMED gone after its teardown, whoever stood it up. This
   * is the set the `confirmed` verdict is decided on, and membership requires a successful
   * `teardown-verify` row — never merely a teardown that returned without complaint. A provider
   * whose teardown is a declared no-op reports success having destroyed nothing, so a teardown
   * row alone proves only that the platform asked.
   */
  reclaimed: Set<string>
  /**
   * Ids THIS RUN stood up that were torn down but NOT confirmed gone: the probe found them
   * standing, could not run, or could not settle the question. `reason` is the probe's verbatim
   * explanation, so the report can say which without a reader going to the logs.
   *
   * Scoped to {@link provisioned} for the same reason {@link stuck} is, and it has to be scoped
   * HERE rather than at each read: the count and the rendered reasons come from this one map, and
   * a filter applied to only one of them prints a neighbouring run's cause beside this run's
   * count. Kept apart from {@link stuck} because the platform's part succeeded here and failed
   * there, and apart from {@link reclaimed} because neither may be reported as a reclaim.
   */
  unconfirmed: Map<string, string | null>
  /**
   * Ids THIS RUN stood up whose latest teardown attempt FAILED. Scoped to the run's own set,
   * because a stuck environment is what the section asks a reader to go and deal with, and a
   * neighbouring run's problem is not this PR's to report.
   */
  stuck: Set<string>
}

/**
 * Index the log rows by environment identity. Rows carrying no `targetId` name no single
 * environment (a provision that failed before a record existed, a stack recipe's per-step rows),
 * so they inform the failure COUNT and never the identity sets: reading a recipe step's success
 * as an environment coming up would invent an environment that then has to be reclaimed.
 */
function indexEnvironments(events: readonly ProvisioningLifecycleEvent[]): LoggedEnvironments {
  const provisioned = new Set<string>()
  const latestTeardown = new Map<string, ProvisioningLifecycleEvent>()
  const latestVerify = new Map<string, ProvisioningLifecycleEvent>()
  for (const event of events) {
    if (!event.targetId) continue
    if (event.operation === 'provision' && event.outcome === 'success') {
      provisioned.add(event.targetId)
    } else if (event.operation === 'teardown') {
      const seen = latestTeardown.get(event.targetId)
      if (!seen || event.createdAt >= seen.createdAt) latestTeardown.set(event.targetId, event)
    } else if (event.operation === 'teardown-verify') {
      const seen = latestVerify.get(event.targetId)
      if (!seen || event.createdAt >= seen.createdAt) latestVerify.set(event.targetId, event)
    }
  }
  const reclaimed = new Set<string>()
  const unconfirmed = new Map<string, string | null>()
  const stuck = new Set<string>()
  for (const [id, event] of latestTeardown) {
    // A teardown of an environment this run has no bring-up row for is still evidence about it;
    // a FAILED one is only this run's problem to report if this run stood it up.
    if (event.outcome !== 'success') {
      if (provisioned.has(id)) stuck.add(id)
      continue
    }
    // The teardown succeeded. Whether the environment is GONE is a separate question, answered
    // only by a verify row — and its ABSENCE is not a pass. A deployment running an older
    // engine, or one whose verify write was lost, records no verify row, and reading that
    // silence as a confirmation is precisely the false tick this whole leg exists to stop.
    const verified = latestVerify.get(id)
    if (verified?.outcome === 'success') reclaimed.add(id)
    else if (provisioned.has(id)) {
      unconfirmed.set(
        id,
        verified?.error ??
          'The teardown was not verified, so whether this environment is gone is unknown.',
      )
    }
  }
  return { provisioned, reclaimed, unconfirmed, stuck }
}

/**
 * Everything the log has to say about this run: the dated timeline a reader sees, and the
 * per-environment accounting the teardown verdict is decided on. They travel together because
 * they are one fold over one read, and letting them be composed apart is how the two would come
 * to disagree about the same rows.
 */
interface LoggedLifecycle {
  timeline: PrReportEnvironmentTimeline
  /** Null whenever the timeline carries a gap: there were no rows to account for. */
  logged: LoggedEnvironments | null
}

/**
 * Fold the run's environment rows in the provisioning log. A gap status means there is nothing
 * to fold, which is reported as the reason it is empty rather than as an empty history (see the
 * header).
 */
function foldLifecycle(read: ProvisioningLifecycleRead): LoggedLifecycle {
  if (read.status !== 'read') {
    return {
      logged: null,
      timeline: {
        gap: read.status,
        note: TIMELINE_GAP_NOTES[read.status],
        provisionedAt: null,
        tornDownAt: null,
        provisionFailures: 0,
        teardownFailures: 0,
        teardownsUnconfirmed: 0,
      },
    }
  }
  const logged = indexEnvironments(read.events)
  let provisionedAt: number | null = null
  let tornDownAt: number | null = null
  let provisionFailures = 0
  for (const event of read.events) {
    if (event.operation === 'provision') {
      if (event.outcome === 'failure') provisionFailures++
      // Only a row naming an environment dates a bring-up: a stack recipe's steps succeed
      // several times on the way to one environment, and the first of those is not when it
      // came up.
      else if (event.targetId && (provisionedAt == null || event.createdAt < provisionedAt)) {
        provisionedAt = event.createdAt
      }
    } else if (event.operation === 'teardown' && event.outcome === 'success') {
      if (tornDownAt == null || event.createdAt > tornDownAt) tornDownAt = event.createdAt
    }
  }
  return {
    logged,
    timeline: {
      gap: null,
      provisionedAt,
      tornDownAt,
      provisionFailures,
      teardownFailures: logged.stuck.size,
      // Already scoped to the run's OWN environments by `indexEnvironments`, matching
      // `teardownFailures`: a neighbouring run's unverified teardown is not something this PR
      // asks anyone to act on, and the reasons rendered below come from the same scoped map.
      teardownsUnconfirmed: logged.unconfirmed.size,
    },
  }
}

/**
 * Whether the run's own step projections POSITIVELY show every environment gone. This is the
 * WEAKER of the two teardown signals and is only consulted when there is no log to read: the
 * projection is written by the run's own polls and is never refreshed once the run settles, so
 * an environment reclaimed by the TTL sweep afterwards keeps a stale `ready` projection forever.
 * The log is what turns "we stopped watching" into "it was torn down at a time".
 *
 * Phrased POSITIVELY (`every`, over a non-empty set) rather than as "nothing looks live",
 * because a run that projected no environment at all would satisfy the negative form and
 * confirm a teardown nobody observed.
 */
function projectionsAllGone(instance: ExecutionInstance): boolean {
  const projections = runEnvironmentProjections(instance.steps)
  return projections.length > 0 && projections.every((env) => isEnvironmentGone(env.status))
}

/**
 * Whether the environments a run stood up are gone again.
 *
 * The RECORDED teardowns win over the projection (see {@link projectionsAllGone}), and a
 * recorded FAILURE is its own answer rather than being flattened into `pending`: an environment
 * still standing because nobody asked and one still standing because the provider refused need
 * different people to do different things.
 *
 * Decided by IDENTITY: `confirmed` means every environment id the log records this run standing
 * up was reclaimed, never that a count of teardowns reached a count of ready frames. The tally
 * form reads as correct until a run replaces an environment mid-flight, at which point the
 * superseded one's teardown balances the books while its replacement is still running.
 *
 * `confirmed` requires POSITIVE evidence from one source or the other. With a readable log that
 * records the bring-up and no teardown, the answer is `pending`: the log not mentioning a
 * teardown IS the observation that none happened, and no projection may override it.
 *
 * And a recorded teardown is not by itself that positive evidence. `confirmed` needs every one
 * of the run's environments to carry a successful VERIFY — an independent probe that found it
 * gone. Where the teardown ran but the probe did not settle it, the answer is `unconfirmed`,
 * which is its own verdict rather than a softened `confirmed`, because the environment may well
 * still be running and still costing money.
 */
function teardownState(
  instance: ExecutionInstance,
  entries: readonly PrReportEnvironment[],
  logged: LoggedEnvironments | null,
): PrVerificationReport['environments']['teardown'] {
  if (!entries.some((e) => e.status === 'ready')) return 'not_applicable'
  // "Still standing", split by whether this run ever intended to reclaim it. Every branch below
  // that would answer `pending` answers `retained` instead when the deployer said so, and only
  // those: a DECLARED retention says nothing about a teardown that was attempted and failed, or
  // one that ran and could not be verified. Those are still the facts they always were.
  const standing = declaresRetainedEnvironment(instance.steps) ? 'retained' : 'pending'
  // No log to read: fall back to the run's own step projections, the weaker signal. This one
  // still yields `confirmed`, because with no log there is no verify row to be missing — the
  // projection is the only evidence there is, and it is the evidence this branch is for.
  if (!logged) return projectionsAllGone(instance) ? 'confirmed' : standing
  if (logged.stuck.size > 0) return 'failed'
  // A log that records no bring-up at all cannot speak to the teardown either way, so the
  // projection is consulted rather than concluding from the log's silence.
  if (logged.provisioned.size === 0) return projectionsAllGone(instance) ? 'confirmed' : standing
  const outstanding = [...logged.provisioned].filter(
    (id) => !logged.reclaimed.has(id) && !logged.unconfirmed.has(id),
  )
  // Something the run stood up has no teardown on record at all: it is still live as far as
  // anyone knows. That outranks an unconfirmed one, because "nobody has asked yet" is a
  // different (and more likely still-running) state than "we asked and could not check".
  if (outstanding.length > 0) return standing
  return [...logged.provisioned].every((id) => logged.reclaimed.has(id))
    ? 'confirmed'
    : 'unconfirmed'
}

/** The tester step whose report the evidence leg reads. */
function testerStep(instance: ExecutionInstance): PipelineStep | undefined {
  return findStep(
    instance,
    (s) => isTesterKind(s.agentKind),
    (s) => s.test?.lastReport != null,
  )
}

/** The empty evidence leg, carrying the reason it is empty. */
function noEvidence(note: string): PrReportEnvironmentEvidence {
  return {
    status: 'absent',
    note,
    ranAgainst: null,
    capturedAt: null,
    outcomes: 0,
    requirementVerdicts: 0,
    screenshots: [],
    url: null,
  }
}

/**
 * What the tester observed, and where. The artifacts are reported whatever the attribution (they
 * exist and a reviewer should be able to reach them), while `status` governs whether they
 * may be read as evidence ABOUT this environment.
 */
function composeEvidence(
  instance: ExecutionInstance,
  inputs: PrReportEnvironmentInputs,
  cap: Capper,
): PrReportEnvironmentEvidence {
  const step = testerStep(instance)
  if (!step) {
    return noEvidence(
      'No tester step in this pipeline, so nothing was exercised against an environment by the platform.',
    )
  }
  const report = step.test?.lastReport
  if (!report) {
    return noEvidence('The tester step produced no report, so nothing was observed anywhere.')
  }
  const ranAgainst = report.environment ?? null
  const screenshots: PrReportEvidenceArtifact[] = cap(
    report.screenshots ?? [],
    'environments.evidence.screenshots',
  ).map((shot) => ({
    view: redactSecrets(shot.view) ?? '',
    artifactId: shot.artifactId,
    hasReference: !!shot.referenceArtifactId,
    url: inputs.artifactUrl?.(shot.artifactId) ?? null,
  }))
  const common = {
    ranAgainst,
    capturedAt: step.finishedAt ?? null,
    outcomes: report.outcomes.length,
    requirementVerdicts: report.requirementVerdicts?.length ?? 0,
    screenshots,
    url: inputs.evidenceUrl,
  }
  if (ranAgainst === 'ephemeral') return { status: 'captured', ...common }
  if (ranAgainst === 'local') {
    return {
      status: 'local',
      note: 'The tester stood its dependencies up locally, so its observations are not evidence about the ephemeral environment below.',
      ...common,
    }
  }
  return {
    status: 'undeclared',
    note: 'The tester report does not say where it ran, so its observations cannot be attributed to the ephemeral environment below.',
    ...common,
  }
}

/**
 * Compose the verdict over the three legs. Every failing condition appends its own line, so
 * `proof: 'incomplete'` is never a bare label, and `complete` is exactly "nothing was found
 * to say".
 */
function composeProof(
  entries: readonly PrReportEnvironment[],
  teardown: PrVerificationReport['environments']['teardown'],
  timeline: PrReportEnvironmentTimeline,
  evidence: PrReportEnvironmentEvidence,
  logged: LoggedEnvironments | null,
): Pick<PrVerificationReport['environments'], 'proof' | 'gaps'> {
  const ready = entries.filter((e) => e.status === 'ready').length
  const failed = entries.filter((e) => e.status === 'failed').length
  // Every frame skipped (or nothing recorded at all) means no environment was ever meant to
  // stand up, so there is no proof to be incomplete about.
  if (ready === 0 && failed === 0) return { proof: 'not_applicable', gaps: [] }

  const gaps: string[] = []
  if (failed > 0) {
    gaps.push(
      `${failed} of ${entries.length} service frames failed to provision, so that part of the system was never stood up.`,
    )
  }
  if (ready === 0) {
    gaps.push('No environment reached a ready state, so nothing could be exercised against one.')
    return { proof: 'incomplete', gaps }
  }
  if (timeline.gap) {
    gaps.push(timeline.note ?? TIMELINE_GAP_NOTES[timeline.gap])
  } else if (timeline.provisionedAt == null) {
    gaps.push(
      'The provisioning log holds no successful bring-up for this run, so when the environment came up is unknown.',
    )
  }
  if (timeline.provisionFailures > 0) {
    gaps.push(
      `${timeline.provisionFailures} provisioning attempt${timeline.provisionFailures === 1 ? '' : 's'} failed for this run.`,
    )
  }
  if (evidence.status !== 'captured') {
    gaps.push(evidence.note ?? 'Nothing was observed against the environment.')
  }
  if (teardown === 'pending') {
    gaps.push('The environment has not been confirmed torn down; it may still be running.')
  }
  // `retained` is deliberately absent from this list. Nothing is missing from the proof: the run
  // did everything it undertook to do, and the reclaim it never undertook cannot be a gap in it.
  // The environment IS still running, which is why the teardown line states so in as many words
  // (`TEARDOWN_RENDERINGS`) rather than the section going quiet about it — a `complete` proof here
  // means "as designed", never "nothing left standing".
  if (teardown === 'unconfirmed') {
    // The probe's own words, not a generic line: "the manifest declares no `teardown:` request"
    // and "the apiserver refused the read" are the same verdict and completely different jobs.
    // Deduped, because one cause (an unverifiable provider) usually explains every frame at once
    // and repeating it per environment would bury the count under identical sentences.
    const reasons = [...new Set([...(logged?.unconfirmed.values() ?? [])].filter(Boolean))]
    const count = timeline.teardownsUnconfirmed
    gaps.push(
      count === 1
        ? 'An environment was torn down but could not be confirmed gone, so it may still be running.'
        : `${count} environments were torn down but could not be confirmed gone, so they may still be running.`,
    )
    for (const reason of reasons) gaps.push(`Teardown could not be verified: ${reason}`)
  }
  if (teardown === 'failed') {
    gaps.push(
      timeline.teardownFailures === 1
        ? 'An environment could not be torn down, so it is still standing and needs reclaiming by hand.'
        : `${timeline.teardownFailures} environments could not be torn down, so they are still standing and need reclaiming by hand.`,
    )
  }
  // The ORDERING check: the two ways captured evidence can be real and still not be about the
  // environment that was standing. Only computable when both ends are dated, which is why it is
  // stated here rather than folded into the evidence status.
  const at = evidence.capturedAt
  if (at != null && timeline.provisionedAt != null && at < timeline.provisionedAt) {
    gaps.push('The tester settled BEFORE the environment came up, so it cannot have used it.')
  }
  // Only once the whole set is reclaimed does `tornDownAt` mark the end of the lifecycle. While
  // anything is still standing it is the last teardown RECORDED, which on a run that replaced an
  // environment mid-flight is the superseded one going away, and testing against its replacement
  // afterwards is exactly what should have happened.
  if (teardown === 'confirmed' && at != null && timeline.tornDownAt != null) {
    if (at > timeline.tornDownAt) {
      gaps.push(
        'The tester settled AFTER the environment was torn down, so it cannot have used it.',
      )
    }
  }
  return { proof: gaps.length === 0 ? 'complete' : 'incomplete', gaps }
}

/**
 * Compose the test-environment lifecycle section. Reads the deployer step's per-frame outcomes,
 * the run's provisioning-log rows and the tester's report, all already resolved by the caller,
 * so nothing here re-probes a provider.
 */
export function composeEnvironments(
  instance: ExecutionInstance,
  inputs: PrReportEnvironmentInputs,
  cap: Capper,
): PrVerificationReport['environments'] {
  const { timeline, logged } = foldLifecycle(inputs.provisioning)
  const evidence = composeEvidence(instance, inputs, cap)
  const step = selectDeployStep(instance.steps)
  const absent = (note: string): PrVerificationReport['environments'] => ({
    status: 'absent',
    note,
    entries: [],
    teardown: 'not_applicable',
    timeline,
    evidence,
    proof: 'not_applicable',
    gaps: [],
  })
  if (!step) {
    return absent('No deployer step in this pipeline, so no ephemeral environment was provisioned.')
  }
  const entries: PrReportEnvironment[] = cap(
    Object.entries(step.deployEnvs ?? {}),
    'environments.entries',
  ).map(([frameId, state]) => ({
    frameId,
    status: state.status,
    url: state.url ?? null,
    error: scrub(state.error),
  }))
  if (entries.length === 0) {
    return absent(
      'The deployer step recorded no environment outcomes (it did not run to completion).',
    )
  }
  const teardown = teardownState(instance, entries, logged)
  return {
    status: 'reported',
    entries,
    teardown,
    timeline,
    evidence,
    ...composeProof(entries, teardown, timeline, evidence, logged),
  }
}

// ---------------------------------------------------------------------------
// Rendering. Every untrusted hole goes through kernel's `hostMarkdown` boundary: a frame id, a
// provider's stderr and a tester's view name all land in a host-parsed, often public PR body.
// ---------------------------------------------------------------------------

/** An epoch-ms instant as a UTC timestamp a reviewer can line up against CI and the log. */
function at(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')
}

/** The proof headline plus, when it is not clean, the lines saying what is missing. */
function renderProof(envs: PrVerificationReport['environments']): string[] {
  if (envs.proof === 'not_applicable') return []
  const headline =
    envs.proof === 'complete'
      ? '**Proof:** ✅ environment up → evidence captured against it → teardown confirmed'
      : '**Proof:** ⚠️ incomplete'
  const out = [headline]
  if (envs.gaps.length) {
    out.push('', ...envs.gaps.map((gap) => `- ${hostMarkdown.cell(gap)}`))
  }
  return [...out, '']
}

function renderTimeline(timeline: PrReportEnvironmentTimeline): string[] {
  // The note is one of this module's own constants, so it needs no host-markdown escaping.
  if (timeline.gap) {
    return [`**Timeline:** not evidenced. ${timeline.note ?? TIMELINE_GAP_NOTES[timeline.gap]}`]
  }
  const parts: string[] = []
  parts.push(
    timeline.provisionedAt != null ? `up ${at(timeline.provisionedAt)}` : 'no bring-up on record',
  )
  if (timeline.tornDownAt != null) parts.push(`torn down ${at(timeline.tornDownAt)}`)
  if (timeline.provisionFailures > 0) {
    parts.push(`${timeline.provisionFailures} failed provisioning attempts`)
  }
  if (timeline.teardownFailures > 0) {
    parts.push(`${timeline.teardownFailures} could not be torn down`)
  }
  if (timeline.teardownsUnconfirmed > 0) {
    parts.push(`${timeline.teardownsUnconfirmed} unconfirmed`)
  }
  return [`**Timeline:** ${parts.join(' · ')}`]
}

function renderEvidence(evidence: PrReportEnvironmentEvidence): string[] {
  const label =
    evidence.status === 'captured'
      ? '✅ captured from the live environment'
      : evidence.status === 'local'
        ? '➖ the tester ran against local dependencies'
        : evidence.status === 'undeclared'
          ? '❓ the tester did not say where it ran'
          : '➖ none'
  const out = [`**Evidence:** ${label}`]
  if (evidence.status !== 'captured' && evidence.note) out.push(absentNote(evidence.note))
  if (evidence.status === 'absent') return [...out, '']
  const counts = [
    `${evidence.outcomes} area${evidence.outcomes === 1 ? '' : 's'} exercised`,
    `${evidence.requirementVerdicts} requirement verdict${evidence.requirementVerdicts === 1 ? '' : 's'}`,
    `${evidence.screenshots.length} screenshot${evidence.screenshots.length === 1 ? '' : 's'}`,
  ]
  if (evidence.capturedAt != null) counts.push(`observed ${at(evidence.capturedAt)}`)
  out.push(counts.join(' · '))
  if (evidence.url) out.push(`[Open the captured evidence](${evidence.url})`)
  if (evidence.screenshots.length) {
    out.push('', '| View | Artifact | Reference |', '| --- | --- | --- |')
    for (const shot of evidence.screenshots) {
      // The id stays in the cell whether or not a link was built: it is what an operator greps the
      // store for, and a deployment with no public backend URL has no link to offer. The URL is
      // ours (built from configured base + a stored id), so it needs no host-markdown escaping;
      // the LABEL is the untrusted half, and it goes through `codeCell` so its own delimiter is
      // sized to it rather than assumed.
      const id = hostMarkdown.codeCell(shot.artifactId)
      const artifact = shot.url ? `[${id}](${shot.url})` : id
      out.push(
        `| ${hostMarkdown.cell(shot.view)} | ${artifact} | ${shot.hasReference ? 'paired' : '—'} |`,
      )
    }
  }
  return [...out, '']
}

/**
 * Render the section: the computed proof first (it is what a reviewer acts on), then the
 * per-frame outcomes, the dated timeline, the evidence and the teardown verdict.
 */
export function renderEnvironments(envs: PrVerificationReport['environments']): string[] {
  const out = ['### Test environment lifecycle', '']
  if (envs.status === 'absent') {
    return [...out, absentNote(envs.note), '', ...renderEvidence(envs.evidence)]
  }
  out.push(...renderProof(envs))
  out.push('| Service frame | State | URL | Error |', '| --- | --- | --- | --- |')
  for (const entry of envs.entries) {
    out.push(
      `| \`${hostMarkdown.cell(entry.frameId)}\` | ${entry.status} | ${hostMarkdown.cell(entry.url ?? '')} | ${hostMarkdown.cell(entry.error ?? '')} |`,
    )
  }
  out.push('', ...renderTimeline(envs.timeline))
  out.push(`**Teardown:** ${TEARDOWN_RENDERINGS[envs.teardown]}`, '')
  return [...out, ...renderEvidence(envs.evidence)]
}

/**
 * How each teardown verdict reads to a reviewer. An exhaustive `Record` rather than a ternary
 * chain, so a verdict added to the closed vocabulary fails the build here instead of falling
 * through to whatever the last arm happened to be.
 */
const TEARDOWN_RENDERINGS: Record<PrVerificationReport['environments']['teardown'], string> = {
  confirmed: '✅ torn down (confirmed gone)',
  // Deliberately not a tick and not a cross: the platform did its part and the result could not
  // be established. Rendering it either way is the misreport.
  unconfirmed: '⚠️ torn down, but not confirmed gone',
  pending: '⏳ still live',
  // Also still live, and the distinction is the whole point: this run was never going to reclaim
  // it, so a reviewer has nothing to wait for and an operator has no failure to chase.
  retained: '🔒 still live, retained past the run by design',
  failed: '❌ teardown failed',
  not_applicable: 'nothing to tear down',
}
