import type { Clock, Logger, ProvisioningOutcome } from '@cat-factory/kernel'
import type { EnvironmentRecord, EnvironmentRegistryRepository } from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type {
  EnvironmentHandle,
  EnvironmentProvider,
  EnvironmentTeardownRequest,
  TeardownConfirmation,
  TeardownProbe,
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

/**
 * How long a provider's teardown probe may take before the platform stops waiting on it. Sized
 * against the slowest built-in read (the Kubernetes namespace GET's own 30s ceiling) plus room
 * for one retry inside a provider's transport, because exceeding it costs only the confirmation.
 */
const CONFIRM_TEARDOWN_TIMEOUT_MS = 45_000

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
      // Nothing was asked to destroy anything, so nothing can be claimed about the result. An
      // unregistered provider is a deployment-configuration fact, not a blip, so no later sweep
      // will answer differently: whatever it stood up has to be reclaimed by hand.
      const confirmation: TeardownConfirmationResult = {
        confirmation: 'unverifiable',
        reason:
          'The provider that stood this environment up is no longer registered, so its teardown could not be performed or checked.',
      }
      await this.recordTeardownOutcome(record, 'success', null, confirmation)
      return confirmation
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
      // No confirmation: there is nothing to verify about a destroy the provider refused, and a
      // verify row here would invite a reader to weigh a probe against an environment nobody
      // touched.
      await this.recordTeardownOutcome(record, 'failure', getErrorMessage(error), null)
      throw error
    }
    await this.tombstone(record)
    const confirmation = await this.confirm(resolved.provider, request)
    await this.recordTeardownOutcome(record, 'success', null, confirmation)
    return confirmation
  }

  /**
   * Ask the provider whether the environment is actually gone, and classify the answer.
   *
   * Runs AFTER the record is tombstoned, deliberately: the teardown itself succeeded, and a probe
   * that hangs or throws must not undo that or propagate into a caller. Its whole job is to add
   * knowledge, so its worst case is the absence of knowledge, which is exactly what `unconfirmed`
   * states.
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
      return classifyTeardownProbe(await this.withProbeDeadline(probe.call(provider, request)))
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

  /**
   * Bound the probe in wall-clock time, so an unresponsive provider costs the CONFIRMATION and
   * never the teardown.
   *
   * {@link ConfirmTeardown} is a public port: the built-ins all pass a timeout to their own
   * transport, but a deployment's own provider need not, and this seam is awaited inline on two
   * paths that must not stall — the on-demand teardown, which is holding an HTTP request open,
   * and the TTL sweep, which runs every couple of minutes and would otherwise let one wedged
   * environment block every later one in the same pass. A timeout is reported as `unconfirmed`
   * (via the caller's catch) rather than `unverifiable`, because a provider that did not answer
   * in time may well answer on the next sweep, where one with no probe at all never will.
   */
  private async withProbeDeadline(probe: Promise<TeardownProbe>): Promise<TeardownProbe> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        probe,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `the provider did not answer within ${CONFIRM_TEARDOWN_TIMEOUT_MS}ms of being asked`,
                ),
              ),
            CONFIRM_TEARDOWN_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      // The loser of the race keeps the timer alive otherwise, which on Node holds the process
      // open past the work it was doing.
      if (timer) clearTimeout(timer)
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
   * Append this teardown's COMPLETE record — the attempt, then the confirmation when there is one
   * to make — and only then notify.
   *
   * That ordering is the whole contract, and it is ONE method taking the confirmation rather than
   * two a caller sequences, because the hook's consumer READS THE LOG BACK. The PR verification
   * report recomposes its environment section from the recorded rows, and a hook fired between
   * the two writes sees a teardown nothing has verified — indistinguishable, to the reader, from
   * one that was probed and came back unproven. It would therefore publish `unconfirmed` about an
   * environment the very next write proves gone, and because this hook is the LAST edge on an
   * already-settled run, nothing would ever correct it. Splitting the writes across two calls is
   * exactly the bug this shape forecloses.
   *
   * The confirmation is a SECOND row rather than a field on the teardown one, because the two
   * record different observers and a reader has to tell them apart: `teardown` says the provider
   * accepted the call, `teardown-verify` says what an independent probe found afterwards. Only
   * `confirmed` is written as a success, so a consumer reading nothing but the outcome column
   * still cannot mistake an unverified teardown for a reclaimed environment.
   *
   * `confirmation: null` means there was nothing to verify (the provider refused the destroy), as
   * opposed to a verification that could not be made — which is a `TeardownConfirmationResult`
   * carrying its own reason.
   */
  private async recordTeardownOutcome(
    record: EnvironmentRecord,
    outcome: ProvisioningOutcome,
    error: string | null,
    confirmation: TeardownConfirmationResult | null,
  ): Promise<void> {
    await this.logRow(record, 'teardown', outcome, error, null)
    if (confirmation) {
      await this.logRow(
        record,
        'teardown-verify',
        confirmation.confirmation === 'confirmed' ? 'success' : 'failure',
        confirmation.reason,
        // The machine-readable verdict, so a reader distinguishes "still standing" from "could
        // not check" without parsing the prose above it.
        JSON.stringify({ confirmation: confirmation.confirmation }),
      )
    }

    const hook = this.teardownRecordedHook
    if (!hook) return
    await runBestEffort(this.log, 'environment.teardownRecordedHook', () => hook(record, outcome), {
      workspaceId: record.workspaceId,
      environmentId: record.id,
      executionId: record.executionId,
      outcome,
    })
  }

  /**
   * Append ONE row of a teardown's story to the provisioning log. Deliberately private and
   * reachable only from {@link recordTeardownOutcome}: a row written outside that method is a row
   * the notification does not wait for, which is the ordering bug it exists to prevent.
   */
  private async logRow(
    record: EnvironmentRecord,
    operation: 'teardown' | 'teardown-verify',
    outcome: ProvisioningOutcome,
    error: string | null,
    detail: string | null,
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

  private async decryptFields(cipher: string | null): Promise<Record<string, string>> {
    if (!cipher) return {}
    const parsed = JSON.parse(await this.deps.secretCipher.decrypt(cipher))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }
}
