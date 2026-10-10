import {
  type BlindJobStopOutcome,
  type RunnerDispatchKind,
  type RunnerDispatchOptions,
  type RunnerJobRef,
  type RunnerJobStopOutcome,
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
  stopJob(workspaceId: string | undefined, ref: RunnerJobRef): Promise<RunnerJobStopOutcome>
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
 * The refusal STOPS the job it just started, and states whether it managed to. The harness begins
 * work on acceptance, so a refusal that only throws leaves a full agent pass running against the
 * repository, free to push a branch and open a pull request for a step the engine has already
 * failed. Not every backend can stop it (see {@link stopBlindJob}), so the outcome is reported
 * rather than assumed: the refusal message tells the reader either that nothing is running or that
 * they have to go and look.
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
  const stop = await stopBlindJob(jobs, workspaceId, ref, jobLog)
  jobLog.blindJobStopped(stop)
  throw new UnavailableError(
    harnessCapabilityUnsupportedMessage(support.missing, stop),
    'runner_image_capability',
  )
}

/**
 * Stop the job the refusal just decided must not run, and answer with what that ACHIEVED.
 *
 * Deliberately `stopJob` and not `release`, which is a reclaim and answers a different question on
 * every backend: on a per-run container it happens to kill the job, on a pooled one it hands the
 * container BACK with the agent still working in it, and on a self-hosted pool with no `release`
 * template it does nothing at all. All three return the same `void`, so a refusal built on it
 * reported an identical, confident stop for a job that was destroyed, one that was handed to the
 * next run, and one that was never touched.
 *
 * Never throws. A failure to stop must not replace an accurate refusal with a teardown error: the
 * step is being failed either way, and what the reader needs is the capability message. So the
 * failure becomes the fourth outcome, logged with its cause by `runBestEffort` and named in the
 * message rather than swallowed.
 */
async function stopBlindJob(
  jobs: ContainerJobDispatcher,
  workspaceId: string,
  ref: RunnerJobRef,
  jobLog: ContainerJobLog,
): Promise<BlindJobStopOutcome> {
  const outcome = await runBestEffort(jobLog.logger, 'containerAgent.stopBlindJob', () =>
    jobs.stopJob(workspaceId, ref),
  )
  return outcome ?? 'failed'
}
