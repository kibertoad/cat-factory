import type {
  Clock,
  EnvironmentAccessHandle,
  EnvironmentHandle,
  EnvironmentReachability,
  EnvironmentRecord,
  EnvironmentRecordPatch,
  EnvironmentRegistryRepository,
  Logger,
  ProvisionedEnvironment,
  ProvisionFields,
  RouteProbe,
} from '@cat-factory/kernel'
import { assertFound, getErrorMessage, noopLogger } from '@cat-factory/kernel'
import type { ProvisioningLogRecorder } from '../provisioning-logs/ProvisioningLogService.js'
import { foldStatedAddresses, proveEnvironmentRoute } from './environmentReachability.js'
import type { ResolvedEnvironmentProvider } from './environmentRemediation.js'
import {
  boundStatusNote,
  parseReachability,
  recordToHandle,
  serializeReachability,
} from './environments.logic.js'

// ---------------------------------------------------------------------------
// ONE status poll: ask the provider where an environment is now, and write down everything that
// answer said.
//
// Extracted from `EnvironmentProvisioningService` (which keeps a thin delegate) because the poll
// is the one lifecycle step whose whole job is OBSERVATION, and its rules are all about what a
// second look may overwrite: which of the previous answer's values survive it, which are cleared
// unless restated, and what the fact of the poll itself leaves behind. The service around it
// CREATES and SUPERSEDES environments, where nothing has a previous value to reconcile.
//
// For an asynchronous provider this is where the evidence actually is. A create answers 202 with
// no finished deploy job, no load balancers and no readiness detail; every fact worth capturing
// arrives on a later poll, and until #2162 this path handed the whole captured bag back to the
// provider and then persisted a patch that omitted it, so a provider's fields were frozen at
// create time for the entire life of an environment.
// ---------------------------------------------------------------------------

/**
 * Bound collaborators, supplied by the owning service (this holds no state of its own). The
 * lifecycle seams stay THERE: sealing, the URL policy and the expiry rule are the same ones the
 * provision path applies, and re-deriving any of them here is how a poll and a create come to
 * disagree about the row they both write.
 */
export interface EnvironmentStatusPollerDeps {
  registry: EnvironmentRegistryRepository
  /** The provider that stood this environment up, resolved from the row's own type/engine. */
  resolveProvider: (record: EnvironmentRecord) => Promise<ResolvedEnvironmentProvider>
  decryptFields: (record: EnvironmentRecord) => Promise<ProvisionFields>
  /** Seal a freshly stated field bag, through the org cipher the provision path uses. */
  sealFields: (workspaceId: string, fields: ProvisionFields) => Promise<string>
  sealAccess: (
    workspaceId: string,
    access: EnvironmentAccessHandle | null,
  ) => Promise<string | null>
  /** The SSRF/misresolution guard on a provider-supplied URL. Throws; never a boolean. */
  assertPublishableUrl: (url: string | null) => void
  resolveExpiry: (
    provisioned: ProvisionedEnvironment,
    defaultTtlMs: number | undefined,
    base: number,
  ) => number | null
  clock: Clock
  /**
   * Opens one bounded TCP connection, so a proof the fold had to drop can be RE-TAKEN here.
   * Absent ⇒ this deployment probes nothing at all and the poll behaves exactly as it did.
   */
  probe?: RouteProbe
  /** Best-effort provisioning-event log; absent ⇒ polling is unchanged. */
  provisioningLog?: ProvisioningLogRecorder
  logger?: Logger
}

export function createEnvironmentStatusPoller(deps: EnvironmentStatusPollerDeps) {
  const log = (deps.logger ?? noopLogger).child({ scope: 'environmentStatusPoll' })

  /** Re-poll the provider for an environment's status and persist what the answer says. */
  async function refresh(workspaceId: string, id: string): Promise<EnvironmentHandle> {
    const record = assertFound(await deps.registry.get(workspaceId, id), 'Environment', id)
    // Resolve the provider from the record's stored provision type/engine (the handler that stood
    // it up), not the workspace-primary, matching the per-type resolution provisioning uses.
    const resolved = await deps.resolveProvider(record)
    const provisioned = await readStatus(workspaceId, record, resolved)
    deps.assertPublishableUrl(provisioned.url)

    const patch = await buildPatch(record, resolved, provisioned)
    await deps.registry.update(workspaceId, id, patch)
    await logFailedTransition(workspaceId, record, resolved, provisioned)
    return recordToHandle({ ...record, ...patch })
  }

  /** The provider's answer, with a THROW logged as the failed attempt it is and re-raised. */
  async function readStatus(
    workspaceId: string,
    record: EnvironmentRecord,
    resolved: ResolvedEnvironmentProvider,
  ): Promise<ProvisionedEnvironment> {
    try {
      return await resolved.provider.status({
        manifest: resolved.manifest,
        externalId: record.externalId,
        provisionFields: await deps.decryptFields(record),
        resolveSecret: resolved.resolveSecret,
      })
    } catch (error) {
      await deps.provisioningLog?.record({
        workspaceId,
        subsystem: 'environment',
        operation: 'status',
        targetId: record.id,
        providerId: resolved.manifest.providerId,
        blockId: record.blockId,
        executionId: record.executionId,
        outcome: 'failure',
        error: getErrorMessage(error),
        detail: null,
      })
      throw error
    }
  }

  async function buildPatch(
    record: EnvironmentRecord,
    resolved: ResolvedEnvironmentProvider,
    provisioned: ProvisionedEnvironment,
  ): Promise<EnvironmentRecordPatch> {
    const { workspaceId } = record
    return {
      status: provisioned.status,
      url: provisioned.url,
      externalId: provisioned.externalId ?? record.externalId,
      expiresAt: deps.resolveExpiry(provisioned, resolved.manifest.defaultTtlMs, record.createdAt),
      accessCipher: await deps.sealAccess(workspaceId, provisioned.access),
      // Everything THIS answer captured, re-sealed. The status poll is where an asynchronous
      // provider's facts arrive (the finished deploy job, the balancer FQDNs, its own readiness
      // detail), and the whole bag is what the provider stated, so it REPLACES rather than merges:
      // a key it has stopped stating has stopped being true, and a bag nothing can clear is the
      // trap the clear-unless-restated rule on `lastError` and `statusNote` below exists to avoid.
      // `null` is an answer that made no statement about the bag (a narrower status shape than the
      // create's, the no-`status`-template fallback) and keeps what is stored, which is what stops
      // a poll erasing the teardown state the create response supplied. See
      // {@link ProvisionedEnvironment.fields}.
      ...(provisioned.fields
        ? { provisionFieldsCipher: await deps.sealFields(workspaceId, provisioned.fields) }
        : {}),
      reachability: serializeReachability(await foldRoute(record, provisioned)),
      // Persist the provider's failure reason on a poll-time transition to `failed` (cleared once
      // not failed), mirroring the provisionSync path. WITHOUT this, a reconcile that flips an env
      // to `failed` (a provider reporting the verdict on `provisioned.error` rather than throwing)
      // left `lastError` stale/empty, so the env-detail surface and the env self-test showed a
      // generic "provisioning failed" instead of the real cause (e.g. a "404 No commit found
      // for the ref …" pointing at a project↔repo mismatch).
      lastError:
        provisioned.status === 'failed' ? provisioned.error?.trim() || 'Provisioning failed' : null,
      // Rewritten from THIS poll on every poll, whatever the status: it is the provider's current
      // account of where the environment is, so a note it has stopped saying stops being stored
      // (the same clear-unless-restated rule as `lastError`, applied to every status rather than
      // to `failed` alone). This is the write that makes the readiness ceiling able to name the
      // state a run was stuck in, because every poll that KEEPS a readiness wait alive lands here.
      statusNote: boundStatusNote(provisioned.statusNote),
      // The trail a poll that SUCCEEDS leaves. Everything else on this path records only a poll
      // that threw or one that transitioned the environment to `failed`, so a readiness wait that
      // polled cleanly for four minutes left two log rows a second apart at the create and nothing
      // after them; an investigation then read that absence as the absence of polling and stated
      // it as fact. A row per poll is the wrong shape at a ten-second cadence, and this pair is
      // enough to tell a four-minute wait from no wait at all. See
      // {@link EnvironmentRecord.lastPolledAt} for why the count is a floor and the stamp is not.
      lastPolledAt: deps.clock.now(),
      pollCount: record.pollCount + 1,
    }
  }

  /**
   * Re-read the provider's stated addresses, keep the proof beside them for as long as it still
   * establishes something (see `foldStatedAddresses`), and RE-TAKE one the fold had to drop.
   *
   * The re-take is what stops this being a silent regression. `proveEnvironmentRoute` is otherwise
   * reached from exactly one place, the deployer's frame settle, which will not run again for a
   * frame that already settled; a dropped proof and a proof never taken are the same value, so
   * everything built on it (the note an agent is handed, the address a container bridge is built
   * from) would just stop, with nothing to say it had.
   *
   * Narrowed to a `ready` environment with a prober wired and a proof that ACTUALLY went: nothing
   * has proved a provisioning environment yet, and taking a first proof here would put a probe on
   * every poll of every environment whose deployer has not settled it.
   */
  async function foldRoute(
    record: EnvironmentRecord,
    provisioned: ProvisionedEnvironment,
  ): Promise<EnvironmentReachability | null> {
    const stored = parseReachability(record.reachability)
    const folded = foldStatedAddresses(stored, record.url, provisioned.addresses, provisioned.url)
    if (!deps.probe || !stored?.proof || folded?.proof || provisioned.status !== 'ready') {
      return folded
    }
    const candidates = folded?.candidates ?? []
    const proof = await proveEnvironmentRoute(provisioned.url, candidates, {
      probe: deps.probe,
      clock: deps.clock,
    })
    log.debug('re-proved an environment route the status poll invalidated', {
      workspaceId: record.workspaceId,
      environmentId: record.id,
      state: proof.state,
      ...(proof.reason ? { reason: proof.reason } : {}),
    })
    return { candidates, proof }
  }

  /**
   * A reconciliation that flips the env to `failed` (e.g. a rollout that exceeded its progress
   * deadline, or a vanished namespace: the cases the provider maps to `failed` WITHOUT throwing)
   * records a provisioning-log failure on the TRANSITION, so the run's "Infrastructure attempts"
   * shows the env stopped spinning up instead of leaving it silently stuck. Repeated polls of an
   * already-failed env don't re-log. (A read that THROWS is logged in `readStatus`; this covers
   * the non-throwing failed verdict.)
   *
   * Runs AFTER the status patch is persisted and is best-effort: a logging hiccup must not throw
   * back through the poll and leave the env stuck at `provisioning` again, the exact bug this
   * surfacing is meant to fix.
   */
  async function logFailedTransition(
    workspaceId: string,
    record: EnvironmentRecord,
    resolved: ResolvedEnvironmentProvider,
    provisioned: ProvisionedEnvironment,
  ): Promise<void> {
    if (provisioned.status !== 'failed' || record.status === 'failed') return
    try {
      await deps.provisioningLog?.record({
        workspaceId,
        subsystem: 'environment',
        operation: 'status',
        targetId: record.id,
        providerId: resolved.manifest.providerId,
        blockId: record.blockId,
        executionId: record.executionId,
        outcome: 'failure',
        error:
          provisioned.error?.trim() ||
          'Environment provisioning did not complete (it never became ready).',
        detail: null,
      })
    } catch {
      // swallow: the env is already persisted as `failed`; the log entry is advisory
    }
  }

  return { refresh }
}

/** The poller's public shape, so the owning service can type its member. */
export type EnvironmentStatusPoller = ReturnType<typeof createEnvironmentStatusPoller>
