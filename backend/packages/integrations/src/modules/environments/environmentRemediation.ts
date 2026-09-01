import type {
  EnvironmentManifest,
  EnvironmentProvider,
  EnvironmentRecord,
  Logger,
  ProviderRemediationAction,
  ProvisionFields,
  SecretResolver,
} from '@cat-factory/kernel'
import { getErrorMessage, noopLogger, runBestEffort } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The environment module's one MUTATING forensic call: asking a provider to repair an environment
// in place, for the investigation's `restart` remedy.
//
// Split from `environmentDiagnostics.ts` (which gathers and never touches anything) rather than
// sitting beside it, because the two halves answer opposite questions about failure. A gather that
// cannot complete degrades to a thinner bundle and must never throw; a remediation that cannot
// complete has to THROW, because reporting "nothing to do" for a capability that vanished would let
// the engine re-probe an untouched environment and read the unchanged verdict as a remedy that did
// not work.
// ---------------------------------------------------------------------------

/** The resolved provider trio a forensic call needs, exactly as the lifecycle paths resolve it. */
export interface ResolvedEnvironmentProvider {
  manifest: EnvironmentManifest
  provider: EnvironmentProvider
  resolveSecret: SecretResolver
}

/** One appended `remediate` row, as the owning service maps it onto the provisioning log. */
export interface EnvironmentRemediationLogRow {
  workspaceId: string
  environmentId: string
  providerId: string
  blockId: string | null
  executionId: string | null
  outcome: 'success' | 'failure'
  error: string | null
  detail: string
}

/**
 * What either forensic half needs to reach one environment's provider. Declared here and EXTENDED
 * by the gatherer's deps, so the two cannot drift into addressing the same row through different
 * seams.
 */
export interface EnvironmentRemediatorDeps {
  readRecord: (workspaceId: string, id: string) => Promise<EnvironmentRecord | null>
  resolveProvider: (record: EnvironmentRecord) => Promise<ResolvedEnvironmentProvider>
  decryptFields: (record: EnvironmentRecord) => Promise<ProvisionFields>
  /**
   * Append the `remediate` row for a mutation this collaborator performed. Bound by the owning
   * service, which is where the provisioning log's write seam lives; absent ⇒ this deployment
   * keeps no provisioning log, exactly as for every other verb. Best-effort at the call site.
   */
  recordRemediation?: (row: EnvironmentRemediationLogRow) => Promise<void>
  logger?: Logger
}

/**
 * Ask the provider to remediate in place.
 *
 * Every outcome is APPENDED to the provisioning log before it is returned. This is the one call in
 * the module that MUTATES a live cluster, and a mutation with no row of its own is invisible to the
 * two readers that most need it: the investigation's own next round rebuilds its timeline from that
 * log, so an unlogged restart leaves the second round reasoning about an environment it believes
 * nothing has touched, and the operator's provisioning drawer never shows it either.
 */
export function createEnvironmentRemediator(deps: EnvironmentRemediatorDeps) {
  const log = (deps.logger ?? noopLogger).child({ scope: 'environmentRemediation' })

  /** Append one remediation row; best-effort, so a log outage never costs the remediation. */
  async function record(
    environment: EnvironmentRecord,
    providerId: string,
    action: ProviderRemediationAction,
    result: {
      outcome: 'success' | 'failure'
      error: string | null
      applied: boolean
      detail?: string
    },
  ): Promise<void> {
    const append = deps.recordRemediation
    if (!append) return
    await runBestEffort(
      log,
      'record an environment remediation',
      () =>
        append({
          workspaceId: environment.workspaceId,
          environmentId: environment.id,
          providerId,
          blockId: environment.blockId ?? null,
          executionId: environment.executionId ?? null,
          outcome: result.outcome,
          error: result.error,
          detail: JSON.stringify({
            action,
            applied: result.applied,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          }),
        }),
      { workspaceId: environment.workspaceId, environmentId: environment.id, action },
    )
  }

  return async function remediate(args: {
    workspaceId: string
    environmentId: string
    action: ProviderRemediationAction
  }): Promise<{ applied: boolean; detail: string }> {
    const { workspaceId, environmentId, action } = args
    const environment = await deps.readRecord(workspaceId, environmentId)
    if (!environment) throw new Error(`Environment '${environmentId}' is no longer in the registry`)
    const { manifest, provider, resolveSecret } = await deps.resolveProvider(environment)
    const remediateFn = provider.diagnostics?.remediate
    if (!remediateFn) {
      throw new Error(
        `Provider '${manifest.providerId}' offers no in-place remediation for this environment`,
      )
    }
    const provisionFields = await deps.decryptFields(environment)
    try {
      const outcome = await remediateFn.call(provider.diagnostics, {
        manifest,
        externalId: environment.externalId,
        provisionFields,
        resolveSecret,
        action,
      })
      // `applied: false` is a FAILURE row, not a quiet success: the requested remediation did not
      // happen, and the timeline's job is to say whether anything touched this environment.
      await record(environment, manifest.providerId, action, {
        outcome: outcome.applied ? 'success' : 'failure',
        error: outcome.applied ? null : outcome.detail,
        applied: outcome.applied,
        detail: outcome.detail,
      })
      return outcome
    } catch (error) {
      await record(environment, manifest.providerId, action, {
        outcome: 'failure',
        error: getErrorMessage(error),
        applied: false,
      })
      throw error
    }
  }
}
