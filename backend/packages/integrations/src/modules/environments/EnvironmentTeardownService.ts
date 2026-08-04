import type { Clock, Logger, ProvisioningOutcome } from '@cat-factory/kernel'
import type { EnvironmentRecord, EnvironmentRegistryRepository } from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type {
  EnvironmentHandle,
  EnvironmentProvider,
  EnvironmentTeardownRequest,
  TeardownConfirmation,
} from '@cat-factory/kernel'
import { assertFound, getErrorMessage, noopLogger, runBestEffort } from '@cat-factory/kernel'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService.js'
import { classifyTeardownProbe, recordToHandle } from './environments.logic.js'
import type { ProvisioningLogRecorder } from '../provisioning-logs/ProvisioningLogService.js'

/**
 * What an independent probe made of an environment after its teardown call succeeded, plus the
 * verbatim reason when it is anything but `confirmed`. `reason` is null exactly when the
 * confirmation is `confirmed` — there is nothing to explain about a proof.
 */
export interface TeardownConfirmationResult {
  confirmation: TeardownConfirmation
  reason: string | null
}

/** A completed teardown: the tombstoned handle, plus whether the environment is provably gone. */
export interface TeardownResult extends TeardownConfirmationResult {
  handle: EnvironmentHandle
}

// EnvironmentTeardownService: destroys provisioned environments — on demand and,
// via `sweepExpired`, when their TTL elapses (driven by the cron). Best-effort:
// the local record is always tombstoned so an unreachable provider can't leave
// the registry wedged; the provider call surfaces errors to the caller.

/**
 * Notified after a teardown ATTEMPT has been recorded in the provisioning log, whether it
 * succeeded or failed. Its one consumer today is the run's PR verification report, whose
 * environment-lifecycle proof cannot be closed by the run itself: the TTL sweep that reclaims the
 * environment fires long after the last step settled, so without this edge the PR says "still
 * live" about an environment the platform destroyed on schedule.
 *
 * The FAILURE edge matters as much as the success one, and for the same reason. A run that has
 * settled has no step hook left to fire, so an environment the provider refuses to reclaim would
 * otherwise sit on the PR as "nobody has torn this down yet" rather than as the thing an operator
 * has to go and do: the same unreachable-leg hole one state over. The hook is therefore fired
 * from the ONE place that records the attempt, so a future third teardown path cannot forget it.
 *
 * Strictly best-effort and swallowed by the service: reclaiming infrastructure must never
 * depend on a downstream bookkeeping write.
 */
export type EnvironmentTeardownRecordedHook = (
  record: EnvironmentRecord,
  outcome: ProvisioningOutcome,
) => Promise<void>

export interface EnvironmentTeardownServiceDependencies {
  connectionService: EnvironmentConnectionService
  environmentRegistryRepository: EnvironmentRegistryRepository
  secretCipher: SecretCipher
  clock: Clock
  /** Best-effort provisioning-event log; absent ⇒ teardown is unchanged. */
  provisioningLog?: ProvisioningLogRecorder
  /** Structured logger for the best-effort hook below; absent ⇒ its failures are unreported. */
  logger?: Logger
}

export class EnvironmentTeardownService {
  private readonly log: Logger
  /**
   * Late-bound because the engine that consumes it is constructed AFTER this service (it is
   * injected into the provisioning service, which the engine takes). Same shape as
   * `setInitiativeLoop` in the composition root, and for the same reason.
   */
  private teardownRecordedHook: EnvironmentTeardownRecordedHook | undefined

  constructor(private readonly deps: EnvironmentTeardownServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /** Late-bind the teardown-recorded notification. Unset ⇒ nothing is notified. */
  setTeardownRecordedHook(hook: EnvironmentTeardownRecordedHook | undefined): void {
    this.teardownRecordedHook = hook
  }

  /**
   * Tear down a single environment and tombstone its record, returning the handle alongside
   * what an INDEPENDENT probe made of it afterwards.
   *
   * The confirmation is part of the return rather than a follow-up call because every caller
   * that reports a teardown to a human needs it: the `disposer` step renders it into the run,
   * the PR verification report turns it into the lifecycle proof's third leg, and neither may
   * state that an environment is gone on the strength of a provider call that returned without
   * complaint (see {@link TeardownConfirmation}).
   */
  async teardown(workspaceId: string, id: string): Promise<TeardownResult> {
    const record = assertFound(
      await this.deps.environmentRegistryRepository.get(workspaceId, id),
      'Environment',
      id,
    )
    const confirmation = await this.teardownRecord(record)
    return {
      handle: recordToHandle({ ...record, status: 'torn_down' }),
      ...confirmation,
    }
  }

  /**
   * Tear down every environment whose TTL has elapsed. Returns the count swept.
   *
   * "Swept" counts the environments this pass tore down, INCLUDING the ones it could not
   * confirm gone: the record is tombstoned either way (the provider accepted the call), so
   * counting only confirmed ones would report the same environment as un-swept forever while
   * the sweep never touches it again. What the unconfirmed ones leave behind is the recorded
   * `teardown-verify` failure, which is where an operator reads about them.
   */
  async sweepExpired(now: number): Promise<number> {
    const expired = await this.deps.environmentRegistryRepository.listExpired(now)
    let swept = 0
    for (const record of expired) {
      try {
        await this.teardownRecord(record)
        swept++
      } catch {
        // Best-effort: a failing provider must not block the rest of the sweep.
        // The record stays live and is retried on the next pass.
      }
    }
    return swept
  }

  private async teardownRecord(record: EnvironmentRecord): Promise<TeardownConfirmationResult> {
    // Resolve the provider from the RECORD's stored provision type/engine (the handler that stood
    // it up), not the workspace-primary — so a workspace with several per-type handlers tears each
    // env down through the right one.
    const resolved = await this.deps.connectionService
      .resolveProviderForRecord(record)
      .catch(() => null)
    // If the provider was unregistered we can't call its API; just tombstone.
    if (!resolved) {
      await this.tombstone(record)
      await this.logAttempt(record, 'teardown', 'success', null)
      // Nothing was asked to destroy anything, so nothing can be claimed about the result. An
      // unregistered provider is a deployment-configuration fact, not a blip, so no later sweep
      // will answer differently: whatever it stood up has to be reclaimed by hand.
      return await this.settle(record, {
        confirmation: 'unverifiable',
        reason:
          'The provider that stood this environment up is no longer registered, so its teardown could not be performed or checked.',
      })
    }
    const provisionFields = await this.decryptFields(record.provisionFieldsCipher)
    const request = {
      manifest: resolved.manifest,
      externalId: record.externalId,
      provisionFields,
      resolveSecret: resolved.resolveSecret,
    }
    try {
      await resolved.provider.teardown(request)
    } catch (error) {
      // Log the verbatim provider error before it propagates (the sweep swallows
      // it; an on-demand teardown surfaces it). The local record is NOT tombstoned
      // on a provider failure, matching the existing retry-next-pass behaviour.
      await this.logAttempt(
        record,
        'teardown',
        'failure',
        error instanceof Error ? error.message : String(error),
      )
      // A failed teardown has nothing to confirm, so this is the whole story and the
      // notification goes out now.
      await this.notifyTeardownRecorded(record, 'failure')
      throw error
    }
    await this.tombstone(record)
    await this.logAttempt(record, 'teardown', 'success', null)
    return await this.settle(record, await this.confirm(resolved.provider, request))
  }

  /**
   * Land the confirmation row and only THEN notify.
   *
   * The ordering is the whole point, and getting it wrong is invisible: the hook's consumer is
   * the run's PR verification report, which re-reads this log when it fires. Notifying between
   * the two rows publishes a report composed from a log that records the teardown and not its
   * confirmation, so every environment reads as `unconfirmed` — the exact state the confirmation
   * exists to resolve, republished as fact and not corrected until something else happens to
   * publish again. The same rule the teardown row itself has always followed, one row later.
   */
  private async settle(
    record: EnvironmentRecord,
    result: TeardownConfirmationResult,
  ): Promise<TeardownConfirmationResult> {
    await this.recordConfirmation(record, result)
    await this.notifyTeardownRecorded(record, 'success')
    return result
  }

  /**
   * Ask the provider whether the environment is actually gone, and classify the answer.
   *
   * Runs AFTER the record is tombstoned and the teardown attempt logged, deliberately: the
   * teardown itself succeeded, and a probe that hangs or throws must not undo that or propagate
   * into a caller. Its whole job is to add knowledge, so its worst case is the absence of
   * knowledge, which is exactly what `unconfirmed` states.
   *
   * A provider with no {@link ConfirmTeardown} is `unverifiable` rather than confirmed, which is
   * the entire inversion this change makes: silence about an environment is no longer read as
   * its death.
   */
  private async confirm(
    provider: EnvironmentProvider,
    request: EnvironmentTeardownRequest,
  ): Promise<TeardownConfirmationResult> {
    const probe = provider.confirmTeardown
    if (!probe) {
      return {
        confirmation: 'unverifiable',
        reason: 'This environment provider cannot confirm whether a teardown took effect.',
      }
    }
    try {
      return classifyTeardownProbe(await probe.call(provider, request))
    } catch (error) {
      return {
        confirmation: 'unconfirmed',
        // `getErrorMessage`, not `describeError`: this string is rendered to a human on a PR,
        // where the latter's structured log fields would land as `[object Object]`. It is scrubbed
        // by the same `redactSecrets` pass either way.
        reason: `The teardown could not be verified: ${getErrorMessage(error)}`,
      }
    }
  }

  private async tombstone(record: EnvironmentRecord): Promise<void> {
    await this.deps.environmentRegistryRepository.softDelete(
      record.workspaceId,
      record.id,
      this.deps.clock.now(),
    )
  }

  /**
   * Append the confirmation as its OWN `teardown-verify` row and hand it back to the caller.
   *
   * A second row rather than a field on the teardown one, because the two record different
   * observers and the reader has to be able to tell them apart: `teardown` says the provider
   * accepted the call, this says what was found afterwards. Only `confirmed` is written as a
   * success, so a consumer that reads nothing but the outcome column still cannot mistake an
   * unverified teardown for a reclaimed environment.
   */
  private async recordConfirmation(
    record: EnvironmentRecord,
    result: TeardownConfirmationResult,
  ): Promise<TeardownConfirmationResult> {
    await this.logAttempt(
      record,
      'teardown-verify',
      result.confirmation === 'confirmed' ? 'success' : 'failure',
      result.reason,
      // The machine-readable verdict, so a reader distinguishes "still standing" from "could not
      // check" without parsing the prose above it.
      JSON.stringify({ confirmation: result.confirmation }),
    )
    return result
  }

  /** Append one row of a teardown's story to the provisioning log. Never notifies: see
   *  {@link notifyTeardownRecorded} for why the two are separate. */
  private async logAttempt(
    record: EnvironmentRecord,
    operation: 'teardown' | 'teardown-verify',
    outcome: ProvisioningOutcome,
    error: string | null,
    detail: string | null = null,
  ): Promise<void> {
    await this.deps.provisioningLog?.record({
      workspaceId: record.workspaceId,
      subsystem: 'environment',
      operation,
      targetId: record.id,
      providerId: record.providerId,
      blockId: record.blockId,
      executionId: record.executionId,
      outcome,
      error,
      detail,
    })
  }

  /**
   * Notify that a teardown has been fully recorded — EVERY row of it.
   *
   * Split from the row write (it used to be one method) because a teardown is now TWO rows and
   * the notification belongs after the last of them, not after the first. Its consumer re-reads
   * the log when it fires, so firing between the rows publishes a report that sees the teardown
   * and not its confirmation, and states `unconfirmed` about an environment that was confirmed
   * gone a millisecond later.
   *
   * The FAILURE edge still fires from the one path that has nothing left to record, which is what
   * keeps it structural rather than a line someone remembered to add beside the success one.
   */
  private async notifyTeardownRecorded(
    record: EnvironmentRecord,
    outcome: ProvisioningOutcome,
  ): Promise<void> {
    const hook = this.teardownRecordedHook
    if (!hook) return
    await runBestEffort(this.log, 'environment.teardownRecordedHook', () => hook(record, outcome), {
      workspaceId: record.workspaceId,
      environmentId: record.id,
      executionId: record.executionId,
      outcome,
    })
  }

  private async decryptFields(cipher: string | null): Promise<Record<string, string>> {
    if (!cipher) return {}
    const parsed = JSON.parse(await this.deps.secretCipher.decrypt(cipher))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }
}
