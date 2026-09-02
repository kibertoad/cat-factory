import type { EnvironmentRouteCandidate, EnvironmentRouteProof } from '@cat-factory/contracts'
import { describeRouteCandidate } from '@cat-factory/contracts'
import type {
  EnvironmentDiagnosis,
  EnvironmentEvidenceBundle,
  EnvironmentFailureFacts,
  EnvironmentRecord,
  EnvironmentRouteEvidence,
  EnvironmentTimelineEntry,
  ProviderRemediationAction,
  ProvisionFields,
  ProvisioningLogRecord,
} from '@cat-factory/kernel'
import {
  describeError,
  describeRouteTargets,
  getErrorMessage,
  noopLogger,
  redactSecretFields,
  redactSecrets,
} from '@cat-factory/kernel'
import {
  createEnvironmentRemediator,
  type EnvironmentRemediatorDeps,
  type ResolvedEnvironmentProvider,
} from './environmentRemediation.js'
import { parseReachability } from './environments.logic.js'

// ---------------------------------------------------------------------------
// The environment module's DIAGNOSTIC READS, answering "what is actually wrong with this
// environment".
//
// Extracted as one cohesive collaborator over a deps object of bound callbacks (the
// `connectionProbes.ts` shape), because `EnvironmentProvisioningService` keeps thin delegates and
// these are the only methods that answer a FORENSIC question rather than driving the lifecycle.
// Its mutating sibling ("make the provider do something about it") is
// `environmentRemediation.ts`, composed in below: a gather may never throw and a remediation must.
//
// The evidence is deliberately assembled from four independent sources and never merged into one
// verdict here: the platform's own registry row, the provider's captured field bag, the run's
// provisioning log, and the provider's optional describe. Reconciling them is the investigation's
// job and the whole reason it exists: the motivating failure was two sources disagreeing, and a
// gatherer that picked a winner would have deleted the finding before anyone saw it.
// ---------------------------------------------------------------------------

export type { ResolvedEnvironmentProvider }

/**
 * Bound collaborators, supplied by the owning service (this holds no state of its own). Extends
 * the remediator's, because both halves address the same row through the same provider seams.
 */
export interface EnvironmentDiagnosticsDeps extends EnvironmentRemediatorDeps {
  /**
   * The run's provisioning attempts, newest first, as the log controller reads them. Absent ⇒ the
   * facade wires no provisioning log, and the bundle's timeline carries the registry row's own
   * dates alone. Best-effort: a log read that throws is caught and NAMED in the timeline rather
   * than dropping the whole investigation.
   */
  listProvisioningLog?: (
    workspaceId: string,
    executionId: string,
  ) => Promise<ProvisioningLogRecord[]>
}

/**
 * What one gather produced: the model-facing bundle, plus what the SAME provider resolve says the
 * provider will do if asked. Returned together rather than through two calls because resolving a
 * provider opens the connection's sealed secrets, which is a `/internal/persistence` round trip
 * for a mothership node.
 */
export interface EnvironmentEvidence {
  bundle: EnvironmentEvidenceBundle
  providerActions: readonly ProviderRemediationAction[]
}

/**
 * The failure the investigation is about, supplied by the caller (it is run state, not env
 * state). Kernel's shape, re-exported here so the owning service can name it without importing
 * the port twice.
 */
export type { EnvironmentFailureFacts }

/**
 * How many provisioning-log rows enter the timeline. A run brings several containers up at once
 * and the log is appended to in bursts, so the whole run's history would swamp the evidence the
 * investigation is actually about; forty covers a fan-out of frames with their retries.
 */
const TIMELINE_ROW_CAP = 40

/** Per-log-entry detail cap. The tail of a 40 KB apply error repeats one cause many times over. */
const TIMELINE_DETAIL_CAP = 600

/**
 * Cap on ONE diagnostic log excerpt, applied ON TOP of whatever the provider already did. The
 * provider caps for its own transport; this caps for the prompt, and the two are different
 * budgets. Stated on the excerpt when it bites, so a reader cannot mistake a cut log for one that
 * genuinely ended there.
 */
const DIAGNOSTIC_LOG_CAP = 4000

/**
 * The rest of the bundle's budget. Everything a provider or a field bag can hand over is
 * unbounded at the port: a namespace with thirty crash-looping pods and twenty warning events
 * yields facts whose values embed whole Kubernetes condition messages, and a provider is free to
 * have captured a rendered manifest into its field bag. The prompt is ONE string, so an uncapped
 * section does not degrade the diagnosis, it costs the whole round: `generateText` rejects on
 * context length, the investigation throws, and the budget is spent with nothing to show. That is
 * the input-side twin of the truncated-verdict failure `MAX_OUTPUT_TOKENS` is sized against.
 *
 * Each cap is per SECTION rather than one running total, so a fat fact set cannot starve the
 * provision fields of their share. Together with the log and timeline caps above the assembled
 * bundle is bounded at roughly 156k characters (~39k tokens): 120x460 facts + 60x460 fields +
 * 5x4000 logs + 40x440 gaps + 40x660 timeline + 40x260 route. Every cut is STATED, in the values
 * themselves where it is one value, and in the bundle's `evidenceCaps` where it is a whole entry.
 */
const DIAGNOSIS_FACT_CAP = 120
const DIAGNOSIS_FACT_VALUE_CAP = 400
const DIAGNOSIS_LOG_COUNT_CAP = 5
const DIAGNOSIS_GAP_CAP = 40
const DIAGNOSIS_GAP_REASON_CAP = 400
const PROVISION_FIELD_CAP = 60
const PROVISION_FIELD_VALUE_CAP = 400

/**
 * The route section's share of that budget. Twenty of each is well past what the platform itself
 * can produce (`planRouteProbes` plans at most nine targets), and the point of a cap on a list the
 * platform bounds is that `candidates` is not one: it comes straight off a provider's response
 * mapping, so its length is the provider's to choose. The per-string cap is `MAX_PROBE_DETAIL_CHARS`
 * plus room for a label, since an address the platform will dial is short by construction and a
 * long one is a sign the mapping picked up something else entirely.
 */
const ROUTE_CANDIDATE_CAP = 20
const ROUTE_ATTEMPT_CAP = 20
const ROUTE_TEXT_CAP = 260

/**
 * Why there is no environment record, in the three ways there can fail to be one.
 *
 * The read FAILING and the row being gone are kept apart for the reason every other degradation
 * in here is: a transport error against the environment store and an environment that is genuinely
 * no longer registered want opposite reactions, and an investigator shown the second concludes the
 * environment was already reclaimed.
 */
function describeUnreadableEnvironment(
  environmentId: string | null,
  error: string | undefined,
): string {
  if (!environmentId) {
    return 'The provision failed before an environment was recorded, so there is nothing to read.'
  }
  if (error) {
    return (
      `Environment '${environmentId}' could not be READ from the registry (${error}), so nothing ` +
      'about it could be gathered. This is a platform read failure, NOT evidence that the ' +
      'environment is absent; treat it as UNKNOWN.'
    )
  }
  return `Environment '${environmentId}' is no longer in the registry, so nothing could be read about it.`
}

/**
 * What the bundle says when the provider itself could not be resolved (a connection deleted under
 * the run, a manifest that no longer parses). Named as its own gap rather than folded into "the
 * provider offers no diagnostics": one means nothing was asked because there was nobody to ask,
 * the other that the question was asked and declined.
 */
const PROVIDER_UNRESOLVED =
  'The provider for this environment could not be resolved, so nothing beyond the environment ' +
  'record and its captured provision fields could be read. Treat the absence of provider facts ' +
  'as UNKNOWN, never as healthy.'

export function createEnvironmentDiagnostics(deps: EnvironmentDiagnosticsDeps) {
  const log = (deps.logger ?? noopLogger).child({ scope: 'environmentDiagnostics' })

  /**
   * Gather everything the platform can say about a failed environment.
   *
   * Nothing in here may throw, full stop: this runs on the failure path of a run that has already
   * gone wrong, and an investigation that cannot be assembled has to degrade to a thinner bundle
   * rather than replace the run's real problem with its own. That includes the registry read the
   * whole gather starts from, which is the one read that used to propagate: a transient store
   * error there surfaced on the caller's poll path as an unreadable poll, and the run fast-failed
   * as a timeout instead of ending on the provider error it actually had. Each read that fails is
   * NAMED in the bundle it could not fill.
   *
   * The provider's declared remediations come back BESIDE the bundle rather than from a second
   * call, because resolving a provider opens the connection's sealed secrets (a
   * `/internal/persistence` round trip under mothership mode), and asking twice per round for two
   * halves of the same resolve is two.
   */
  async function collect(args: {
    workspaceId: string
    environmentId: string | null
    executionId?: string
    failure: EnvironmentFailureFacts
  }): Promise<EnvironmentEvidence> {
    const { workspaceId, environmentId, executionId, failure } = args
    const read = await readRecordSafely(workspaceId, environmentId)
    const record = read.record
    // Opened before the first read that can cut something. The route evidence is prepared on the
    // way in (scrubbed and bounded) exactly like every other provider-authored section, so it
    // needs somewhere to record what it dropped.
    const caps: string[] = []
    const route = readRoute(record, caps)
    const timeline = await readTimeline(deps.listProvisioningLog, {
      workspaceId,
      executionId: executionId ?? record?.executionId ?? undefined,
      record,
      route,
    })
    if (!record) {
      return {
        providerActions: [],
        bundle: {
          environment: {
            id: environmentId,
            // Not `failed`: nothing was read, and a status invented here would be the one fact the
            // investigation trusts most. The failure below is all that is actually known.
            status: 'unknown',
            url: null,
            expiresAt: null,
            lastError: null,
            provisionType: null,
            engine: null,
          },
          provisionFields: {},
          timeline,
          route,
          diagnosisUnavailable: describeUnreadableEnvironment(environmentId, read.error),
          ...(caps.length > 0 ? { evidenceCaps: caps } : {}),
          failure,
        },
      }
    }

    const fields = await readFields(record)
    // STATED rather than left as an empty bag: a provision-field set that could not be decrypted
    // and one the provider never captured look identical, and the first is a platform fault the
    // investigation should be reasoning about rather than reasoning from.
    if (fields.error) {
      timeline.push({
        at: null,
        label: 'captured provision fields could not be decrypted',
        detail: fields.error,
      })
    }
    const provider = await resolveProviderSafely(record)
    const diagnosis = provider ? await describeSafely(record, provider, fields.values) : null
    const prepared = diagnosis?.diagnosis ? prepareDiagnosis(diagnosis.diagnosis, caps) : undefined

    return {
      providerActions: declaredRemediations(provider),
      bundle: {
        environment: {
          id: record.id,
          status: record.status,
          url: record.url,
          expiresAt: record.expiresAt,
          lastError: record.lastError ?? null,
          provisionType: record.provisionType ?? null,
          engine: record.engine ?? null,
        },
        provisionFields: prepareFields(fields.values, caps),
        timeline,
        route,
        ...(prepared ? { diagnosis: prepared } : {}),
        ...(diagnosis?.unavailable ? { diagnosisUnavailable: diagnosis.unavailable } : {}),
        ...(provider ? {} : { diagnosisUnavailable: PROVIDER_UNRESOLVED }),
        ...(caps.length > 0 ? { evidenceCaps: caps } : {}),
        failure,
      },
    }
  }

  /**
   * The registry row, or the reason there is none. Guarded like every other read in here rather
   * than trusted: it is the FIRST read, so a throw here loses the whole bundle AND, before this
   * was wrapped, the caller's own failure path with it.
   */
  async function readRecordSafely(
    workspaceId: string,
    environmentId: string | null,
  ): Promise<{ record: EnvironmentRecord | null; error?: string }> {
    if (!environmentId) return { record: null }
    try {
      return { record: await deps.readRecord(workspaceId, environmentId) }
    } catch (error) {
      log.warn('could not read the environment record for an investigation', {
        workspaceId,
        environmentId,
        ...describeError(error),
      })
      return { record: null, error: getErrorMessage(error) }
    }
  }

  async function readFields(
    record: EnvironmentRecord,
  ): Promise<{ values: ProvisionFields; error?: string }> {
    try {
      return { values: await deps.decryptFields(record) }
    } catch (error) {
      log.warn('could not decrypt provision fields for an environment investigation', {
        workspaceId: record.workspaceId,
        environmentId: record.id,
        ...describeError(error),
      })
      return { values: {}, error: getErrorMessage(error) }
    }
  }

  async function resolveProviderSafely(
    record: EnvironmentRecord,
  ): Promise<ResolvedEnvironmentProvider | null> {
    try {
      return await deps.resolveProvider(record)
    } catch (error) {
      log.warn('could not resolve the provider for an environment investigation', {
        workspaceId: record.workspaceId,
        environmentId: record.id,
        ...describeError(error),
      })
      return null
    }
  }

  async function describeSafely(
    record: EnvironmentRecord,
    resolved: ResolvedEnvironmentProvider,
    provisionFields: ProvisionFields,
  ): Promise<{ diagnosis?: EnvironmentDiagnosis; unavailable?: string }> {
    const diagnostics = resolved.provider.diagnostics
    if (!diagnostics) {
      return {
        unavailable:
          `The '${resolved.manifest.providerId}' provider implements no diagnostics, so nothing ` +
          'beyond the environment record and its captured provision fields could be read. Treat ' +
          'the absence of provider facts as UNKNOWN, never as healthy.',
      }
    }
    try {
      return {
        diagnosis: await diagnostics.describe({
          manifest: resolved.manifest,
          externalId: record.externalId,
          provisionFields,
          resolveSecret: resolved.resolveSecret,
        }),
      }
    } catch (error) {
      return {
        unavailable: `The provider's own diagnosis could not be read: ${getErrorMessage(error)}`,
      }
    }
  }

  return { collect, remediate: createEnvironmentRemediator(deps) }
}

/** How the provisioning log was read, as its own fact rather than a length to infer from. */
type ProvisioningLogRead =
  | { state: 'read'; records: ProvisioningLogRecord[]; dropped: number }
  | { state: 'unwired' }
  | { state: 'unattached' }
  | { state: 'failed'; error: string }

/**
 * The ONE derived timeline: the record's own dates, the run's provisioning attempts, the route
 * proof, the marker saying status polls happened at all, and what READING the provisioning log
 * did, sorted into one order.
 *
 * The proof and the poll marker are folded in rather than left beside the log for a reader to
 * reconcile, and that is the whole point of the shape. An investigation asked to line the
 * timestamps up against a two-entry log said the reachability verdict "settled roughly at the
 * moment of the create request, with no wait", while `proof.checkedAt` in the same bundle put it
 * 4m18s later, and built its headline on the contradiction.
 *
 * The log's OWN state is an entry too, always, for the same reason the poll marker is one. Once
 * the record's dates and that marker joined this list, an absent provisioning log stopped being
 * distinguishable from an empty one by the list coming back empty, which is what the renderer's
 * "draw no conclusion from the silence" guard had been doing. A deployment that keeps no log, an
 * environment attached to no run, a read that threw, and a run that genuinely appended nothing
 * are four facts wanting four different reactions, and only the last is about the environment.
 *
 * A module-level function rather than a closure over `deps`, because everything it needs is one
 * optional reader and the collaborator it used to sit inside is at its own function-size budget.
 */
async function readTimeline(
  listProvisioningLog: EnvironmentDiagnosticsDeps['listProvisioningLog'],
  args: {
    workspaceId: string
    executionId: string | undefined
    record: EnvironmentRecord | null
    route: EnvironmentRouteEvidence
  },
): Promise<EnvironmentTimelineEntry[]> {
  const { workspaceId, executionId, record, route } = args
  const entries: EnvironmentTimelineEntry[] = []
  if (record) {
    entries.push({ at: record.createdAt, label: 'environment record created' })
    entries.push(describePollMarker(record))
    if (record.deletedAt) {
      entries.push({ at: record.deletedAt, label: 'environment record tombstoned' })
    }
  }
  if (route.proof) entries.push(describeRouteProof(route.proof, route.candidates))
  entries.push(...describeLogRead(await readLogRows(listProvisioningLog, workspaceId, executionId)))
  return entries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

/**
 * The provisioning log's rows, and the state it was read in. Every state but `read` is a fact
 * about the PLATFORM rather than about the run, which is why each is its own member.
 */
async function readLogRows(
  listProvisioningLog: EnvironmentDiagnosticsDeps['listProvisioningLog'],
  workspaceId: string,
  executionId: string | undefined,
): Promise<ProvisioningLogRead> {
  if (!listProvisioningLog) return { state: 'unwired' }
  if (!executionId) return { state: 'unattached' }
  try {
    const rows = await listProvisioningLog(workspaceId, executionId)
    // Newest first from the repository; the timeline reads oldest first, and the cap has to drop
    // the OLDEST rows rather than the newest, which are the ones about this failure.
    return {
      state: 'read',
      records: rows.slice(0, TIMELINE_ROW_CAP),
      dropped: Math.max(0, rows.length - TIMELINE_ROW_CAP),
    }
  } catch (error) {
    return { state: 'failed', error: getErrorMessage(error) }
  }
}

/** The provisioning log's contribution to the timeline: how it was read, then what it held. */
function describeLogRead(rows: ProvisioningLogRead): EnvironmentTimelineEntry[] {
  if (rows.state === 'unwired') {
    return [
      {
        at: null,
        label: 'this deployment keeps NO provisioning log',
        detail:
          'There is no record of provisioning attempts to read, so nothing below is one. That is ' +
          'a fact about the deployment and not about this environment: draw no conclusion from ' +
          'the absence of attempts, including about how long anything took.',
      },
    ]
  }
  if (rows.state === 'unattached') {
    return [
      {
        at: null,
        label: 'this environment is attached to no run, so no provisioning log was read',
        detail:
          'The provisioning log is keyed by RUN. An environment carrying no run has no log to ' +
          'read, which is again a fact about the record rather than about the attempt.',
      },
    ]
  }
  if (rows.state === 'failed') {
    return [{ at: null, label: 'provisioning log could not be read', detail: rows.error }]
  }
  const entries: EnvironmentTimelineEntry[] = []
  if (rows.records.length === 0) {
    entries.push({
      at: null,
      label: 'the provisioning log was READ and holds nothing for this run',
      detail:
        'It is wired, it answered, and it had no rows. So nothing was ever appended for this run: ' +
        'an unusual fact, but a real one rather than a read that did not happen.',
    })
  }
  if (rows.dropped > 0) {
    entries.push({
      at: null,
      label: `${rows.dropped} older provisioning-log rows for this run were not included`,
      detail: `The timeline keeps the ${TIMELINE_ROW_CAP} most recent rows; the ones dropped are the OLDEST.`,
    })
  }
  for (const row of rows.records) {
    entries.push({
      at: row.createdAt,
      label: `${row.subsystem}.${row.operation} ${row.outcome}${
        row.targetId ? ` (${row.targetId})` : ''
      }`,
      ...(row.error || row.detail
        ? { detail: capText(row.error ?? row.detail ?? '', TIMELINE_DETAIL_CAP) }
        : {}),
    })
  }
  return entries
}

/**
 * What the platform knows about reaching this environment, or the reason it knows nothing.
 *
 * An unreadable stored value is NAMED rather than folded into the empty case, for the reason
 * every other degradation in here is: "the provider stated no addresses" is a determinate cause
 * with a named owner that the investigation is meant to rank first, and a parse failure
 * masquerading as it would have a reader send someone to fix a mapping that is fine.
 */
function readRoute(record: EnvironmentRecord | null, caps: string[]): EnvironmentRouteEvidence {
  if (!record?.reachability) return { candidates: [], proof: null }
  const parsed = parseReachability(record.reachability)
  if (!parsed) {
    return {
      candidates: [],
      proof: null,
      unreadable:
        "This environment's stored reachability value could not be parsed, so neither the " +
        'addresses and names its provider stated nor what dialling them proved could be read. ' +
        'Treat both as UNKNOWN: this is a platform read failure, NOT a provider that stated no ' +
        'targets.',
    }
  }
  return prepareRoute(parsed.candidates, parsed.proof, caps)
}

/**
 * The route evidence, scrubbed and bounded, like every other provider-authored section.
 *
 * It reads as platform data and is not. `candidates` is whatever a provider's response mapping
 * pointed at (an array with no declared length, holding strings with no declared length), and an
 * attempt's `detail` is the probe's own error text, which on some runtimes echoes the target back
 * with whatever the URL carried. Both cross into a model prompt and the telemetry store from here,
 * which is the boundary `prepareDiagnosis` and `prepareFields` already guard; this section shipped
 * past it unredacted and uncapped while its own neighbour in the timeline was scrubbed.
 *
 * Scrub BEFORE the cap, per CLAUDE.md's compose-time rule. `state`, `reason` and `checkedAt` are
 * left alone: two are closed vocabularies and the third is a number.
 */
function prepareRoute(
  candidates: readonly EnvironmentRouteCandidate[],
  proof: EnvironmentRouteProof | null,
  caps: string[],
): EnvironmentRouteEvidence {
  // Every string field, because a candidate carries EITHER an address or a name and both are
  // provider-authored: scrubbing only the one this deployment happens to use is how the other
  // ships a credential-bearing value into a prompt the first time a manifest starts stating it.
  const kept = candidates.slice(0, ROUTE_CANDIDATE_CAP).map((entry) => ({
    ...(entry.address === undefined
      ? {}
      : { address: capText(scrub(entry.address), ROUTE_TEXT_CAP) }),
    ...(entry.host === undefined ? {} : { host: capText(scrub(entry.host), ROUTE_TEXT_CAP) }),
    ...(entry.label ? { label: capText(scrub(entry.label), ROUTE_TEXT_CAP) } : {}),
  }))
  if (candidates.length > kept.length) {
    caps.push(
      `The provider stated ${candidates.length} targets for this environment; only the first ` +
        `${kept.length} are below. The rest are UNKNOWN, not absent, and the proof below was ` +
        'taken against the targets the platform actually dialled, which it lists itself.',
    )
  }
  if (!proof) return { candidates: kept, proof: null }
  const attempts = proof.attempts.slice(0, ROUTE_ATTEMPT_CAP).map((attempt) => ({
    target: capText(scrub(attempt.target), ROUTE_TEXT_CAP),
    outcome: attempt.outcome,
    ...(attempt.detail ? { detail: capText(scrub(attempt.detail), ROUTE_TEXT_CAP) } : {}),
  }))
  if (proof.attempts.length > attempts.length) {
    caps.push(
      `The route proof recorded ${proof.attempts.length} attempts; only the first ` +
        `${attempts.length} are below.`,
    )
  }
  return {
    candidates: kept,
    proof: {
      ...proof,
      via: proof.via === null ? null : capText(scrub(proof.via), ROUTE_TEXT_CAP),
      attempts,
    },
  }
}

/**
 * The timeline entry for the platform's own status polling: WHEN the provider last answered one,
 * and how many answers there have been.
 *
 * Always present for a record that was read, including the case where the answer is none. An
 * absent marker and a marker saying zero are the two readings the failure that filed this could
 * not tell apart, and it picked the one that supported a fault: "there is no later poll of any
 * kind" against an environment that had been polled for nearly four minutes.
 *
 * An ANSWER, never a success, matching the row it renders. A provider that reports a deterministic
 * rejection on `provisioned.error` rather than throwing is answering, so its polls are counted,
 * and "22 successful polls" for an environment that failed all 22 is the same over-claim this
 * marker exists to remove.
 */
function describePollMarker(record: EnvironmentRecord): EnvironmentTimelineEntry {
  if (!record.lastPolledAt || record.pollCount <= 0) {
    return {
      at: null,
      label: 'no provider status poll is RECORDED for this environment',
      detail:
        'The platform records the last answered poll and a count of them on the environment row. ' +
        'Neither is set here, so either nothing polled it or it was created before this marker ' +
        'existed. An answered poll writes no log row of its own at any cadence, so the ' +
        'provisioning entries below are not a record of polling either way.',
    }
  }
  const polls = record.pollCount === 1 ? '1 answer' : `${record.pollCount} answers`
  return {
    at: record.lastPolledAt,
    label: `last answered provider status poll (${polls} recorded)`,
    detail:
      'Answered polls write this marker rather than one log row each, and an answer of any ' +
      'status counts: this says how much polling HAPPENED, not how much of it went well. The ' +
      'count is a FLOOR, since concurrent polls can cost it an increment, so it never ' +
      'over-reports. The stamp is exact, and it is the LAST answer only: polling is not ' +
      'necessarily continuous between the record being created and this moment, because several ' +
      'unrelated surfaces refresh an environment (a readiness wait, a human-test gate opening ' +
      'hours later, an environment self-test), and any one of them moves the stamp. Read the span ' +
      'as a window polling happened INSIDE, never as its duration.',
  }
}

/**
 * The timeline entry for the route proof: WHEN the platform dialled, and what came back.
 *
 * Dated from `proof.checkedAt`, which is a required field on the stored proof and was populated
 * and contradicted in the incident this exists for. Every target is listed, because an attempt
 * list holding exactly one entry, the URL's own name, beside no stated candidates is the
 * determinate cause the prompt then ranks first.
 */
function describeRouteProof(
  proof: EnvironmentRouteProof,
  candidates: readonly EnvironmentRouteCandidate[],
): EnvironmentTimelineEntry {
  // Kernel's renderer, which the two operator sentences and the investigation prompt also use:
  // one template for one field. Already scrubbed and capped by `prepareRoute`, which owns this
  // bundle's boundary onto a prompt.
  const tried = describeRouteTargets(proof.attempts)
  // Kernel's candidate renderer, so a stated NAME is marked as one here exactly as it is in the
  // investigation's own route section: printed bare into a sentence about addresses it reads as an
  // address somebody typed wrong.
  const stated = candidates.length
    ? candidates.map(describeRouteCandidate).join(', ')
    : "none (the URL's own name was the only target that existed)"
  return {
    at: proof.checkedAt,
    label: `route proof: ${proof.state}${proof.reason ? ` (${proof.reason})` : ''}`,
    detail:
      `Targets the provider stated for this URL: ${stated}. ` +
      `${proof.via ? `Carried via ${proof.via}${proof.viaHost ? ` (resolved from ${proof.viaHost})` : ''}. ` : ''}` +
      `${tried ? `Tried, in order: ${tried}.` : 'Nothing was tried.'} ` +
      'This is when the platform DIALLED the environment, which is a different moment from when ' +
      'the environment was created and from when a step failed.',
  }
}

/**
 * The remediations a resolved provider will actually perform. Empty for a provider that implements
 * no diagnostics, or declares none, or declares some without the `remediate` that runs them. The
 * three degrade identically ON PURPOSE, because the engine's question is "will something happen
 * if I ask", and a half-declared capability answers no.
 */
function declaredRemediations(
  resolved: ResolvedEnvironmentProvider | null,
): readonly ProviderRemediationAction[] {
  const diagnostics = resolved?.provider.diagnostics
  if (!diagnostics?.remediate) return []
  return diagnostics.supportedActions ?? []
}

/** The diagnostics collaborator's public shape, so the owning service can type its member. */
export type EnvironmentDiagnostics = ReturnType<typeof createEnvironmentDiagnostics>

/**
 * Make the provider's own account safe and BOUNDED for the prompt, recording every cut in `caps`.
 *
 * SCRUBBED here rather than trusted to the provider. The port's own docblock used to declare the
 * excerpt "already capped and redacted BY THE PROVIDER", and that is the right thing to ASK of a
 * provider (only it knows which of its fields carry credentials), but it cannot be the only line
 * of defence: a diagnosis is mostly control-plane text the provider never authored (a pod log
 * tail, a warning-event message, a Deployment condition), which is exactly where a bad DSN or a
 * failed `Authorization` echo shows up. This is the boundary onto a model prompt and the telemetry
 * store, so it applies the shape-based net over whatever the provider already did.
 *
 * Scrub BEFORE the cap, per CLAUDE.md's compose-time rule: capping first can leave the tail of a
 * credential behind as the head of the kept slice.
 */
function prepareDiagnosis(diagnosis: EnvironmentDiagnosis, caps: string[]): EnvironmentDiagnosis {
  const factsDropped = Math.max(0, diagnosis.facts.length - DIAGNOSIS_FACT_CAP)
  if (factsDropped > 0) {
    caps.push(
      `The provider reported ${diagnosis.facts.length} facts; only the first ${DIAGNOSIS_FACT_CAP} ` +
        `are below. ${factsDropped} were not included and are UNKNOWN, not absent.`,
    )
  }
  const logs = (diagnosis.logs ?? []).slice(0, DIAGNOSIS_LOG_COUNT_CAP).map((entry) => {
    const text = scrub(entry.text)
    if (text.length <= DIAGNOSTIC_LOG_CAP) return { ...entry, text }
    // Capped from the TAIL: the end of a failing container's output is where the cause is, and a
    // head cap would reliably keep the banner and drop the crash.
    return { ...entry, text: text.slice(text.length - DIAGNOSTIC_LOG_CAP), truncated: true }
  })
  const logsDropped = (diagnosis.logs?.length ?? 0) - logs.length
  if (logsDropped > 0) {
    caps.push(`${logsDropped} further provider log excerpts were not included.`)
  }
  const gaps = (diagnosis.gaps ?? [])
    .slice(0, DIAGNOSIS_GAP_CAP)
    .map((gap) => ({ ...gap, reason: capText(scrub(gap.reason), DIAGNOSIS_GAP_REASON_CAP) }))
  const gapsDropped = (diagnosis.gaps?.length ?? 0) - gaps.length
  if (gapsDropped > 0) {
    caps.push(`${gapsDropped} further reads the provider could not make were not listed.`)
  }
  return {
    facts: diagnosis.facts
      .slice(0, DIAGNOSIS_FACT_CAP)
      .map((fact) => ({ ...fact, value: capText(scrub(fact.value), DIAGNOSIS_FACT_VALUE_CAP) })),
    ...(logs.length > 0 ? { logs } : {}),
    ...(gaps.length > 0 ? { gaps } : {}),
  }
}

/**
 * The captured field bag, scrubbed and bounded. The scrub is {@link redactSecretFields} rather
 * than a plain one because the bag's KEY is the only context a value like `9f2c…` carries.
 */
function prepareFields(values: ProvisionFields, caps: string[]): Record<string, string> {
  const entries = Object.entries(redactSecretFields(values))
  const kept = entries.slice(0, PROVISION_FIELD_CAP)
  if (entries.length > kept.length) {
    caps.push(
      `The provider captured ${entries.length} provision fields; only ${kept.length} are below ` +
        '(the first by insertion order). The rest are UNKNOWN, not absent.',
    )
  }
  return Object.fromEntries(
    kept.map(([key, value]) => [key, capText(value, PROVISION_FIELD_VALUE_CAP)]),
  )
}

/** {@link redactSecrets} narrowed to the non-null case; it only returns null for a null input. */
function scrub(value: string): string {
  return redactSecrets(value) ?? ''
}

/** Head-capped text with the drop STATED, for a field whose beginning carries the meaning. */
function capText(value: string, cap: number): string {
  if (value.length <= cap) return value
  const dropped = value.length - cap
  return `${value.slice(0, cap)} […${dropped} more characters were not included]`
}
