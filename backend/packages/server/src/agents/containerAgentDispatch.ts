import {
  type RunnerDispatchKind,
  type RunnerDispatchOptions,
  type RunnerJobRef,
  UnavailableError,
  harnessCapabilityUnsupportedMessage,
  parseHarnessBodyCapabilities,
  requiredHarnessCapabilities,
  resolveHarnessCapabilitySupport,
  runBestEffort,
} from '@cat-factory/kernel'
import type { ContainerJobLog } from './containerAgentLogging.js'

// ACCEPTING one container job: hand the body to the runner, record the transition, and hold the
// answer to the harness's capability handshake before anything downstream treats the job as real.
//
// Extracted from `ContainerAgentExecutor` rather than written inline because the three steps are
// one concern (a dispatch is not accepted until the harness has said it can serve the body) and
// because the executor is at its size ratchet. The job client arrives as a structural interface,
// so this stays drivable with two functions rather than a transport or a container.

/**
 * The structural subset of the server's `RunnerJobClient` this module drives. Declared here so a
 * test can pass two functions rather than a transport, the same shape the provisioning service's
 * `DeployJobClient` uses for the same reason.
 */
export interface ContainerJobDispatcher {
  dispatch(
    workspaceId: string | undefined,
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind,
    options?: RunnerDispatchOptions,
  ): Promise<{ capabilities?: readonly string[] } | undefined>
  release(workspaceId: string | undefined, ref: RunnerJobRef): Promise<void>
}

/** One job's addressing plus the seam that records what happened to it. */
export interface AcceptContainerJobArgs {
  workspaceId: string
  ref: RunnerJobRef
  body: Record<string, unknown>
  kind: RunnerDispatchKind
  options?: RunnerDispatchOptions
  /** The job's bound log/metrics seam. */
  jobLog: ContainerJobLog
  /** Non-secret fields for the dispatch transition line (resolved model, provider, backend kind). */
  fields: { model: string; provider: string; kind: RunnerDispatchKind }
}

/**
 * Dispatch the job and refuse a BLIND run.
 *
 * An image older than a body capability does not reject the field, it ignores it, and because
 * this backend composed the prompt, the agent is then reading that it has tools or a skill that
 * were never installed. The handshake is the first signal the backend has ever had about what a
 * runner image (above all a self-hosted pool's, which lags by design) actually parses.
 *
 * Three answers, three dispositions, and the middle one is why this is not a boolean:
 *
 *   - supported: nothing to do.
 *   - unknown (no handshake reported): the image predates the handshake, or the pool's control
 *     plane does not forward the harness's acceptance. It may well serve the capability, and
 *     refusing here would take out every run on every deployment one image behind, on no evidence.
 *     So the BLIND SPOT is reported (a warn line plus a counter) and the run proceeds.
 *   - unsupported: the image SAID it does not parse the field. Refuse.
 *
 * The refusal stops the job it just started: the harness begins work on acceptance, so leaving it
 * would run a full agent pass (possibly opening a PR) for a step the engine has already failed.
 * The reclaim is best-effort, so a teardown that fails must not replace the accurate refusal.
 *
 * Runs BEFORE the caller records anything about the dispatch, because a refused job is one that
 * should never have been treated as started.
 */
export async function acceptContainerJob(
  jobs: ContainerJobDispatcher,
  args: AcceptContainerJobArgs,
): Promise<void> {
  const { workspaceId, ref, body, kind, jobLog, fields } = args
  let ack: { capabilities?: readonly string[] } | undefined
  try {
    ack = await jobs.dispatch(workspaceId, ref, body, kind, args.options)
  } catch (error) {
    jobLog.dispatchFailed(error, fields)
    throw error
  }
  jobLog.dispatched(fields)
  const support = resolveHarnessCapabilitySupport(
    requiredHarnessCapabilities(body),
    parseHarnessBodyCapabilities(ack?.capabilities),
  )
  jobLog.capabilityGap(support)
  if (support.kind !== 'unsupported') return
  await runBestEffort(jobLog.logger, 'containerAgent.stopBlindJob', () =>
    jobs.release(workspaceId, ref),
  )
  throw new UnavailableError(
    harnessCapabilityUnsupportedMessage(support.missing),
    'runner_image_capability',
  )
}
