import type {
  EnvironmentDiagnosis,
  EnvironmentEvidenceBundle,
  EnvironmentManifest,
  EnvironmentProvider,
  EnvironmentRecord,
  EnvironmentTimelineEntry,
  Logger,
  ProviderRemediationAction,
  ProvisionFields,
  ProvisioningLogRecord,
  SecretResolver,
} from '@cat-factory/kernel'
import { describeError, getErrorMessage, noopLogger, redactSecretFields } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The environment module's DIAGNOSTIC READS, answering "what is actually wrong with this
// environment" and
// "make the provider do something about it".
//
// Extracted as one cohesive collaborator over a deps object of bound callbacks (the
// `connectionProbes.ts` shape), because `EnvironmentProvisioningService` keeps thin delegates and
// these are the only methods that answer a FORENSIC question rather than driving the lifecycle.
//
// The evidence is deliberately assembled from four independent sources and never merged into one
// verdict here: the platform's own registry row, the provider's captured field bag, the run's
// provisioning log, and the provider's optional describe. Reconciling them is the investigation's
// job and the whole reason it exists: the motivating failure was two sources disagreeing, and a
// gatherer that picked a winner would have deleted the finding before anyone saw it.
// ---------------------------------------------------------------------------

/** The resolved provider trio a diagnostic read needs, exactly as the lifecycle paths resolve it. */
export interface ResolvedEnvironmentProvider {
  manifest: EnvironmentManifest
  provider: EnvironmentProvider
  resolveSecret: SecretResolver
}

/** Bound collaborators, supplied by the owning service (this holds no state of its own). */
export interface EnvironmentDiagnosticsDeps {
  readRecord: (workspaceId: string, id: string) => Promise<EnvironmentRecord | null>
  resolveProvider: (record: EnvironmentRecord) => Promise<ResolvedEnvironmentProvider>
  decryptFields: (record: EnvironmentRecord) => Promise<ProvisionFields>
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
  logger?: Logger
}

/** The failure the investigation is about, supplied by the caller (it is run state, not env state). */
export interface EnvironmentFailureFacts {
  error: string
  reason?: string
  waitedMs?: number
}

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
   * Nothing in here may throw for a reason short of "there is no such environment": this runs on
   * the failure path of a run that has already gone wrong, and an investigation that cannot be
   * assembled has to degrade to a thinner bundle rather than replace the run's real problem with
   * its own. Each read that fails is NAMED in the bundle it could not fill.
   */
  async function collect(args: {
    workspaceId: string
    environmentId: string | null
    executionId?: string
    failure: EnvironmentFailureFacts
  }): Promise<EnvironmentEvidenceBundle> {
    const { workspaceId, environmentId, executionId, failure } = args
    const record = environmentId ? await deps.readRecord(workspaceId, environmentId) : null
    const timeline = await readTimeline(workspaceId, executionId, record)
    if (!record) {
      return {
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
        diagnosisUnavailable: environmentId
          ? `Environment '${environmentId}' is no longer in the registry, so nothing could be read about it.`
          : 'The provision failed before an environment was recorded, so there is nothing to read.',
        failure,
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

    return {
      environment: {
        id: record.id,
        status: record.status,
        url: record.url,
        expiresAt: record.expiresAt,
        lastError: record.lastError ?? null,
        provisionType: record.provisionType ?? null,
        engine: record.engine ?? null,
      },
      provisionFields: redactSecretFields(fields.values),
      timeline,
      ...(diagnosis?.diagnosis ? { diagnosis: capDiagnosisLogs(diagnosis.diagnosis) } : {}),
      ...(diagnosis?.unavailable ? { diagnosisUnavailable: diagnosis.unavailable } : {}),
      ...(provider ? {} : { diagnosisUnavailable: PROVIDER_UNRESOLVED }),
      failure,
    }
  }

  /**
   * The remediations the provider will actually perform for this environment. Empty for every
   * provider that implements no diagnostics, or declares none, or declares some without the
   * `remediate` that runs them. The three degrade identically ON PURPOSE, because the engine's
   * question is "will something happen if I ask", and a half-declared capability answers no.
   */
  async function providerActions(
    workspaceId: string,
    environmentId: string | null,
  ): Promise<readonly ProviderRemediationAction[]> {
    if (!environmentId) return []
    const record = await deps.readRecord(workspaceId, environmentId)
    if (!record) return []
    const resolved = await resolveProviderSafely(record)
    const diagnostics = resolved?.provider.diagnostics
    if (!diagnostics?.remediate) return []
    return diagnostics.supportedActions ?? []
  }

  /**
   * Ask the provider to remediate in place. Throws when the environment or the capability is
   * gone: unlike gathering, this is a REQUESTED action, and reporting "nothing to do" for a
   * capability that vanished would let the engine re-probe an untouched environment and read the
   * unchanged verdict as a remedy that did not work.
   */
  async function remediate(args: {
    workspaceId: string
    environmentId: string
    action: ProviderRemediationAction
  }): Promise<{ applied: boolean; detail: string }> {
    const { workspaceId, environmentId, action } = args
    const record = await deps.readRecord(workspaceId, environmentId)
    if (!record) throw new Error(`Environment '${environmentId}' is no longer in the registry`)
    const { manifest, provider, resolveSecret } = await deps.resolveProvider(record)
    const remediateFn = provider.diagnostics?.remediate
    if (!remediateFn) {
      throw new Error(
        `Provider '${manifest.providerId}' offers no in-place remediation for this environment`,
      )
    }
    const provisionFields = await deps.decryptFields(record)
    return remediateFn.call(provider.diagnostics, {
      manifest,
      externalId: record.externalId,
      provisionFields,
      resolveSecret,
      action,
    })
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
  ): Promise<{ records: ProvisioningLogRecord[]; failure?: string }> {
    if (!deps.listProvisioningLog || !executionId) return { records: [] }
    try {
      const rows = await deps.listProvisioningLog(workspaceId, executionId)
      // Newest first from the repository; the timeline reads oldest first, and the cap has to drop
      // the OLDEST rows rather than the newest, which are the ones about this failure.
      return { records: rows.slice(0, TIMELINE_ROW_CAP) }
    } catch (error) {
      return { records: [], failure: getErrorMessage(error) }
    }
  }

  return { collect, providerActions, remediate }
}

/** The diagnostics collaborator's public shape, so the owning service can type its member. */
export type EnvironmentDiagnostics = ReturnType<typeof createEnvironmentDiagnostics>

/**
 * Apply the prompt-side cap to every excerpt, marking each one it bites so a reader cannot mistake
 * a cut log for one that ended there. A log is capped from its TAIL: the end of a failing
 * container's output is where the cause is, and a head cap would reliably keep the banner.
 */
function capDiagnosisLogs(diagnosis: EnvironmentDiagnosis): EnvironmentDiagnosis {
  if (!diagnosis.logs?.length) return diagnosis
  return {
    ...diagnosis,
    logs: diagnosis.logs.map((entry) => {
      if (entry.text.length <= DIAGNOSTIC_LOG_CAP) return entry
      return {
        ...entry,
        text: entry.text.slice(entry.text.length - DIAGNOSTIC_LOG_CAP),
        truncated: true,
      }
    }),
  }
}

/** Head-capped text with the drop STATED, for a field whose beginning carries the meaning. */
function capText(value: string, cap: number): string {
  if (value.length <= cap) return value
  const dropped = value.length - cap
  return `${value.slice(0, cap)} […${dropped} more characters were not included]`
}
