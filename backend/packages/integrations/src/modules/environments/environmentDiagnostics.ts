import type {
  EnvironmentDiagnosis,
  EnvironmentEvidenceBundle,
  EnvironmentFailureFacts,
  EnvironmentRecord,
  EnvironmentTimelineEntry,
  ProviderRemediationAction,
  ProvisionFields,
  ProvisioningLogRecord,
} from '@cat-factory/kernel'
import {
  describeError,
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
 * bundle is bounded at roughly 147k characters (~37k tokens): 120x460 facts + 60x460 fields +
 * 5x4000 logs + 40x440 gaps + 40x660 timeline. Every cut is STATED, in the values themselves
 * where it is one value, and in the bundle's `evidenceCaps` where it is a whole entry.
 */
const DIAGNOSIS_FACT_CAP = 120
const DIAGNOSIS_FACT_VALUE_CAP = 400
const DIAGNOSIS_LOG_COUNT_CAP = 5
const DIAGNOSIS_GAP_CAP = 40
const DIAGNOSIS_GAP_REASON_CAP = 400
const PROVISION_FIELD_CAP = 60
const PROVISION_FIELD_VALUE_CAP = 400

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
    const timeline = await readTimeline(workspaceId, executionId, record)
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
          diagnosisUnavailable: describeUnreadableEnvironment(environmentId, read.error),
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
    const caps: string[] = []
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

  async function readTimeline(
    workspaceId: string,
    executionId: string | undefined,
    record: EnvironmentRecord | null,
  ): Promise<EnvironmentTimelineEntry[]> {
    const entries: EnvironmentTimelineEntry[] = []
    if (record) {
      entries.push({ at: record.createdAt, label: 'environment record created' })
      if (record.deletedAt) {
        entries.push({ at: record.deletedAt, label: 'environment record tombstoned' })
      }
    }
    const rows = await readLogRows(workspaceId, executionId ?? record?.executionId ?? undefined)
    if (rows.failure) {
      entries.push({ at: null, label: 'provisioning log could not be read', detail: rows.failure })
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
    return entries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  }

  async function readLogRows(
    workspaceId: string,
    executionId: string | undefined,
  ): Promise<{ records: ProvisioningLogRecord[]; dropped: number; failure?: string }> {
    if (!deps.listProvisioningLog || !executionId) return { records: [], dropped: 0 }
    try {
      const rows = await deps.listProvisioningLog(workspaceId, executionId)
      // Newest first from the repository; the timeline reads oldest first, and the cap has to drop
      // the OLDEST rows rather than the newest, which are the ones about this failure.
      return {
        records: rows.slice(0, TIMELINE_ROW_CAP),
        dropped: Math.max(0, rows.length - TIMELINE_ROW_CAP),
      }
    } catch (error) {
      return { records: [], dropped: 0, failure: getErrorMessage(error) }
    }
  }

  return { collect, remediate: createEnvironmentRemediator(deps) }
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
