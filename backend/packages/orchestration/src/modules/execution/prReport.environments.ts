import type {
  ExecutionInstance,
  PipelineStep,
  PrReportEnvironment,
  PrReportEnvironmentEvidence,
  PrReportEnvironmentTimeline,
  PrReportEvidenceArtifact,
  PrVerificationReport,
  ProvisioningLogRecord,
} from '@cat-factory/kernel'
import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'
import { isTesterKind } from './ci.logic.js'

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
//  - **Absent is not zero.** A deployment that retains no provisioning log and a run whose
//    environment was never reclaimed produce the same empty timeline and opposite facts, so the
//    unreadable case is flagged (`timeline.evidenced`) rather than rendered as "never torn
//    down". The same rule splits a tester that ran LOCALLY from one that did not SAY where it
//    ran: both are "not evidence about this environment", and only one of them is a decision
//    somebody made.
//
// The section lives here rather than in `prReport.logic.ts` because it is the one section
// composed from a source outside the in-memory run (the provisioning log), and because that file
// is the report's shared spine: the file-size budget is a split trigger, not a number to raise.
// ---------------------------------------------------------------------------

/**
 * The provisioning-log fields the lifecycle timeline reads. Deliberately a narrow structural
 * subset of {@link ProvisioningLogRecord}: this module is pure, and the caller has already
 * scoped the query to the run's `environment` rows.
 */
export type ProvisioningLifecycleEvent = Pick<
  ProvisioningLogRecord,
  'operation' | 'outcome' | 'createdAt'
>

/** The resolved inputs the section needs beyond the run itself. */
export interface PrReportEnvironmentInputs {
  /**
   * The run's ENVIRONMENT rows from the provisioning event log, or `null` when the log could
   * not be read at all (the deployment retains none, or the read failed). The distinction is
   * load-bearing: `[]` says the log was read and holds nothing for this run, `null` says
   * nobody looked, and only the first of those permits any conclusion about the teardown.
   */
  provisioningEvents: readonly ProvisioningLifecycleEvent[] | null
  /**
   * Deep link into the run's captured evidence in the app, or null when the deployment
   * configured no public app URL (the report never emits a link to nowhere).
   */
  evidenceUrl: string | null
}

/** Cap a list, recording what was dropped in the report's own `truncations` log. */
type Capper = <T>(items: readonly T[], label: string) => T[]

/** Scrub credentials out of an optional free-text value, preserving `null`/`undefined`. */
function scrub(value: string | null | undefined): string | null {
  return value == null ? null : (redactSecrets(value) ?? null)
}

/** The lifecycle states that mean an environment is no longer standing. */
const GONE_STATUSES = new Set(['torn_down', 'expired', 'failed'])

/**
 * Fold the run's environment rows in the provisioning log into the dated half of the
 * lifecycle. `null` events mean the log could not be read, which is reported as such rather
 * than as an empty history (see the header).
 */
function composeTimeline(
  events: readonly ProvisioningLifecycleEvent[] | null,
): PrReportEnvironmentTimeline {
  if (!events) {
    return {
      evidenced: false,
      note: 'This deployment retains no provisioning event log, so the environment lifecycle could not be dated.',
      provisionedAt: null,
      tornDownAt: null,
      provisionFailures: 0,
      teardownFailures: 0,
    }
  }
  let provisionedAt: number | null = null
  let tornDownAt: number | null = null
  let provisionFailures = 0
  let teardownFailures = 0
  for (const event of events) {
    if (event.operation === 'provision') {
      if (event.outcome === 'failure') provisionFailures++
      else if (provisionedAt == null || event.createdAt < provisionedAt) {
        provisionedAt = event.createdAt
      }
    } else if (event.operation === 'teardown') {
      if (event.outcome === 'failure') teardownFailures++
      else if (tornDownAt == null || event.createdAt > tornDownAt) tornDownAt = event.createdAt
    }
  }
  return { evidenced: true, provisionedAt, tornDownAt, provisionFailures, teardownFailures }
}

/** How many teardown attempts the log records as having SUCCEEDED. */
function teardownSuccesses(events: readonly ProvisioningLifecycleEvent[] | null): number {
  if (!events) return 0
  return events.filter((e) => e.operation === 'teardown' && e.outcome === 'success').length
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
  const projections = instance.steps.filter((s) => s.environment != null)
  return (
    projections.length > 0 && projections.every((s) => GONE_STATUSES.has(s.environment!.status))
  )
}

/**
 * Whether the environments a run stood up are gone again.
 *
 * The RECORDED teardowns win over the projection (see {@link projectionsAllGone}), and a
 * recorded FAILURE is its own answer rather than being flattened into `pending`: an environment
 * still standing because nobody asked and one still standing because the provider refused need
 * different people to do different things.
 *
 * `confirmed` requires POSITIVE evidence from one source or the other. With a readable log and
 * no teardown row in it, the answer is `pending`: the log not mentioning a teardown IS the
 * observation that none happened, and no projection may override it.
 */
function teardownState(
  instance: ExecutionInstance,
  entries: readonly PrReportEnvironment[],
  timeline: PrReportEnvironmentTimeline,
  reclaimed: number,
): PrVerificationReport['environments']['teardown'] {
  const ready = entries.filter((e) => e.status === 'ready').length
  if (ready === 0) return 'not_applicable'
  if (reclaimed >= ready) return 'confirmed'
  if (timeline.teardownFailures > 0) return 'failed'
  if (reclaimed > 0 || timeline.evidenced) return 'pending'
  return projectionsAllGone(instance) ? 'confirmed' : 'pending'
}

/**
 * The step a leg should read: the LAST matching step that carries evidence, else the first
 * matching step (so a pipeline that has the step but hasn't reached it still gets the "not run
 * yet" note rather than nothing). The same rule `prReport.logic.ts` applies to every other
 * section, for the same reason: a pipeline may carry the kind twice and the later run is the
 * one that describes the PR as it stands now.
 */
function lastWithEvidence(
  instance: ExecutionInstance,
  matches: (step: PipelineStep) => boolean,
  hasEvidence: (step: PipelineStep) => boolean,
): PipelineStep | undefined {
  const matching = instance.steps.filter(matches)
  for (let i = matching.length - 1; i >= 0; i--) {
    if (hasEvidence(matching[i]!)) return matching[i]
  }
  return matching[0]
}

/** The tester step whose report the evidence leg reads. */
function testerStep(instance: ExecutionInstance): PipelineStep | undefined {
  return lastWithEvidence(
    instance,
    (s) => isTesterKind(s.agentKind),
    (s) => s.test?.lastReport != null,
  )
}

/** The deployer step whose per-frame outcomes the "up" leg reads. */
function deployerStep(instance: ExecutionInstance): PipelineStep | undefined {
  return lastWithEvidence(
    instance,
    (s) => s.agentKind === DEPLOYER_AGENT_KIND,
    (s) => Object.keys(s.deployEnvs ?? {}).length > 0,
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
  if (!timeline.evidenced) {
    gaps.push(timeline.note ?? 'The environment lifecycle could not be dated.')
  } else if (timeline.provisionedAt == null) {
    gaps.push(
      'The provisioning log holds no successful bring-up for this run, so when the environment came up is unknown.',
    )
  }
  if (timeline.provisionFailures > 0) {
    gaps.push(
      `${timeline.provisionFailures} provision attempt${timeline.provisionFailures === 1 ? '' : 's'} failed before the environment came up.`,
    )
  }
  if (evidence.status !== 'captured') {
    gaps.push(evidence.note ?? 'Nothing was observed against the environment.')
  }
  if (teardown === 'pending') {
    gaps.push('The environment has not been confirmed torn down; it may still be running.')
  }
  if (teardown === 'failed') {
    gaps.push(
      `${timeline.teardownFailures} teardown attempt${timeline.teardownFailures === 1 ? '' : 's'} failed, so the environment is still standing and needs reclaiming by hand.`,
    )
  }
  // The ORDERING check: the two ways captured evidence can be real and still not be about the
  // environment that was standing. Only computable when both ends are dated, which is why it is
  // stated here rather than folded into the evidence status.
  const at = evidence.capturedAt
  if (at != null && timeline.provisionedAt != null && at < timeline.provisionedAt) {
    gaps.push('The tester settled BEFORE the environment came up, so it cannot have used it.')
  }
  if (at != null && timeline.tornDownAt != null && at > timeline.tornDownAt) {
    gaps.push('The tester settled AFTER the environment was torn down, so it cannot have used it.')
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
  const timeline = composeTimeline(inputs.provisioningEvents)
  const evidence = composeEvidence(instance, inputs, cap)
  const step = deployerStep(instance)
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
    return absent('No deployer step in this pipeline — no ephemeral environment was provisioned.')
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
  const teardown = teardownState(
    instance,
    entries,
    timeline,
    teardownSuccesses(inputs.provisioningEvents),
  )
  return {
    status: 'reported',
    entries,
    teardown,
    timeline,
    evidence,
    ...composeProof(entries, teardown, timeline, evidence),
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
  if (!timeline.evidenced) return [`**Timeline:** not evidenced. ${timeline.note}`]
  const parts: string[] = []
  parts.push(
    timeline.provisionedAt != null ? `up ${at(timeline.provisionedAt)}` : 'no bring-up on record',
  )
  if (timeline.tornDownAt != null) parts.push(`torn down ${at(timeline.tornDownAt)}`)
  if (timeline.provisionFailures > 0) parts.push(`${timeline.provisionFailures} failed provisions`)
  if (timeline.teardownFailures > 0) parts.push(`${timeline.teardownFailures} failed teardowns`)
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
  if (evidence.status !== 'captured' && evidence.note) out.push(`_${evidence.note}_`)
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
      out.push(
        `| ${hostMarkdown.cell(shot.view)} | \`${hostMarkdown.cell(shot.artifactId)}\` | ${shot.hasReference ? 'paired' : '—'} |`,
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
    return [...out, `_${envs.note}_`, '', ...renderEvidence(envs.evidence)]
  }
  out.push(...renderProof(envs))
  out.push('| Service frame | State | URL | Error |', '| --- | --- | --- | --- |')
  for (const entry of envs.entries) {
    out.push(
      `| \`${hostMarkdown.cell(entry.frameId)}\` | ${entry.status} | ${hostMarkdown.cell(entry.url ?? '')} | ${hostMarkdown.cell(entry.error ?? '')} |`,
    )
  }
  out.push('', ...renderTimeline(envs.timeline))
  const teardown =
    envs.teardown === 'confirmed'
      ? '✅ torn down'
      : envs.teardown === 'pending'
        ? '⏳ still live'
        : envs.teardown === 'failed'
          ? '❌ teardown failed'
          : 'nothing to tear down'
  out.push(`**Teardown:** ${teardown}`, '')
  return [...out, ...renderEvidence(envs.evidence)]
}
