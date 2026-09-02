// The run's infra stand-up: the docker-compose dependencies a local-mode service declares, and
// the frontend build/serve + WireMock flow the UI-test runs use instead. Split out of agent.ts,
// which owns the agent MODES; this owns what surrounds a mode with the dependencies it needs and
// guarantees the matching teardown. `manageInfra` is the one entry point a mode calls.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentInfraSpec, InfraSetupRecord, ServiceInfraSpec } from './job.js'
import type { DockerWorkload } from './docker-capability.js'
import {
  type DockerProbe,
  probeLiveDockerCapability,
  readDockerStatus,
  resolveDockerVerdict,
} from './docker-status.js'
import { standUpFrontend, tearDownFrontend } from './frontend-infra.js'
import { captureRedactedOutput, redactSecrets } from './redact.js'
import type { RunOptions } from './runner.js'
import type { Logger } from './logger.js'

const exec = promisify(execFile)

/**
 * Bring the service's docker-compose dependencies up (local infra only). Best-effort:
 * runs `docker compose -f <path> up -d --wait` in the checkout. A compose failure is logged
 * and surfaced to the agent (as a prompt note) rather than failing the job — the agent can
 * still run unit-level tests and report what it could. A no-op for ephemeral / no-infra /
 * no-compose-path runs.
 *
 * A CONFIRMED absence of a USABLE Docker daemon short-circuits it: the container already knows
 * compose cannot work, so running it would only turn a fact this container holds into an error
 * the agent has to interpret. The record then carries the stated cause plus the two facts that
 * decide where a human should look (`dockerAvailable`: was anything answering, `dockerWorkload`:
 * what a container did on it), which is what makes the Tester step say why it ran no infra
 * instead of looking like a Tester that simply chose not to. Anything OTHER than a confirmed
 * negative attempts as before (`DockerStatus.available` in docker-status.ts states why
 * "undecided" is its own value).
 *
 * "Confirmed", not merely recorded: {@link resolveDockerVerdict} re-checks the boot record
 * against a live daemon first, so a warm-pool container whose sidecar came up late is not latched
 * into refusing infra that works. It re-checks a recorded PRESENCE too, by running an actual
 * container: a rootless daemon in a sandbox answers `docker version` while being unable to mount
 * an image, and compose against that one died on a mount error inside the very mechanism that
 * exists to explain why infra did not come up. `probe` is that check, injected so the unit suite
 * can state every answer on a machine that has its own daemon either way.
 *
 * Whether it succeeds or fails, the (redacted, bounded) command output is captured into a
 * {@link InfraSetupRecord} returned alongside the prompt `note`, so the backend can surface
 * the in-container dependency stand-up logs on the Tester step — the failure-class artifact
 * the orchestrator-side provisioning logs can't see.
 *
 * Exported for the unit suite (like {@link buildInfraNotes}): the refusal branch is a decision
 * this container makes about itself, and the acceptance suite can only exercise it on a machine
 * where the daemon genuinely fails.
 */
export async function standUpInfra(
  dir: string,
  infra: ServiceInfraSpec,
  signal: AbortSignal | undefined,
  logger: Logger,
  probe: DockerProbe = probeLiveDockerCapability,
): Promise<{ started: boolean; note?: string; record?: InfraSetupRecord }> {
  if (infra.environment !== 'local' || infra.noInfraDependencies || !infra.composePath) {
    return { started: false }
  }
  const startedAt = Date.now()
  const recorded = await readDockerStatus()
  const docker = await resolveDockerVerdict(recorded, {
    probe,
    ...(signal ? { signal } : {}),
    logger,
  })
  if (docker.refusal) {
    const note = `the dependencies could not be started: ${docker.refusal}`
    logger.warn('agent(explore): infra stand-up refused, no usable docker daemon', {
      composePath: infra.composePath,
      dockerSource: recorded.source,
      dockerReason: recorded.reason,
      // What the LIVE check found, which is the only place the second refusal cause exists: the
      // boot record's own words for a daemon that answers and cannot run anything are `serving`
      // and nothing else, so a log line carrying the record alone describes the wrong failure.
      dockerWorkload: docker.workload?.status ?? 'unmeasured',
      ...(docker.workload?.status === 'unusable' ? { dockerDetail: docker.workload.detail } : {}),
    })
    return {
      started: false,
      note,
      record: {
        started: false,
        // NOT a flat `false`. Two refusals reach this branch and they have opposite fixes: with
        // nothing answering, the executor image or the sandbox running it is what to go and look
        // at; with a daemon that answers and cannot run a container, that daemon is up and an
        // operator sent to restart it finds nothing wrong. `dockerAvailable` answers only the
        // first question and `dockerWorkload` the second, so neither has to carry the other's
        // fact (the same rule the compose-failure branch below states for its own `false`).
        dockerAvailable: docker.daemon === true,
        ...workloadRecord(docker.workload),
        composePath: infra.composePath,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        error: redactSecrets(note),
      },
    }
  }
  try {
    logger.info('agent(explore): standing up infra', { composePath: infra.composePath })
    // Raise maxBuffer well above the 1MB default so a chatty compose stand-up can't fail the
    // (best-effort) infra step with ENOBUFS; the captured output is tail-bounded on storage.
    const { stdout, stderr } = await exec(
      'docker',
      ['compose', '-f', infra.composePath, 'up', '-d', '--wait'],
      { cwd: dir, signal, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 },
    )
    const logs = captureRedactedOutput(stdout, stderr)
    return {
      started: true,
      record: {
        started: true,
        dockerAvailable: true,
        ...workloadRecord(docker.workload),
        composePath: infra.composePath,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        ...(logs ? { logs } : {}),
      },
    }
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err)
    logger.warn('agent(explore): infra stand-up failed', { error: note })
    // `execFile` rejections carry the partial stdout/stderr on the error object — capture them
    // so the stored logs explain the failure (a port clash, a pull-auth error, an exited
    // dependency), not just the one-line exit message.
    const e = err as { stdout?: unknown; stderr?: unknown }
    const logs = captureRedactedOutput(e.stdout, e.stderr)
    return {
      started: false,
      note,
      record: {
        started: false,
        // A compose failure with a REACHABLE daemon, which is a third diagnosis again: the stack
        // itself did not come up. Read off the RESOLVED verdict, so a container whose daemon came
        // up after boot claims the daemon it actually reached rather than the one its boot record
        // still denies, and OMITTED rather than `false` when nothing answered the live check,
        // because the boot record's word for that is a hypothesis and not a measurement.
        ...(docker.daemon === true ? { dockerAvailable: true } : {}),
        ...workloadRecord(docker.workload),
        composePath: infra.composePath,
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        error: redactSecrets(note),
        ...(logs ? { logs } : {}),
      },
    }
  }
}

/**
 * What the live check measured, for the record the Tester step shows.
 *
 * Its own field beside `dockerAvailable` because the two answer different questions and only one
 * of them has a boolean's worth of answers: a daemon either answered or it did not, while what a
 * container DID on it is `usable`, `unusable`, or a check that could not be carried out. Absent
 * when nothing was measured at all (an undecided boot record probes nothing), which is not the
 * same as a check that ran and could not tell.
 */
function workloadRecord(workload: DockerWorkload | undefined): {
  dockerWorkload?: InfraSetupRecord['dockerWorkload']
} {
  if (!workload) return {}
  return { dockerWorkload: workload.status === 'unknown' ? 'undetermined' : workload.status }
}

/**
 * Stand the run's infra up and return a single cleanup handle, dispatching on the spec's
 * `kind`: the frontend UI-test flow (`kind: 'frontend'`) builds/serves the app + WireMock as
 * processes (torn down by killing them); the default backend-service flow stands the
 * docker-compose stack up (torn down with `docker compose down`). Unifying the two here keeps
 * `runExploreMode` free of the branch and guarantees the matching teardown runs in its finally.
 *
 * `dir` is the clone ROOT; `workDir` is the service subtree (equal to `dir` when the run is not
 * monorepo-scoped). The docker-compose stand-up runs at the root (its `composePath` is
 * repo-relative), but the FRONTEND stand-up runs in `workDir`: a monorepo frontend's
 * `package.json` / `outputDir` / `mocks/` all live under the service subtree, so installing,
 * building, serving and seeding WireMock from the root would target the wrong directory.
 */
export async function manageInfra(
  dir: string,
  workDir: string,
  infra: AgentInfraSpec,
  opts: RunOptions,
  logger: Logger,
): Promise<{
  note?: string
  serveUrl?: string
  record?: InfraSetupRecord
  cleanup: () => Promise<void>
}> {
  if (infra.kind === 'frontend') {
    // `onActivity` feeds the inactivity watchdog through the frontend build/serve stand-up,
    // which (unlike docker-compose's 5-min-capped `up`) can run past the inactivity window.
    // Runs in `workDir` so a monorepo frontend builds/serves from its own package subtree.
    const fe = await standUpFrontend(workDir, infra, opts, logger)
    return {
      ...(fe.note ? { note: fe.note } : {}),
      ...(fe.serveUrl ? { serveUrl: fe.serveUrl } : {}),
      record: fe.record,
      cleanup: () => tearDownFrontend(fe.processes, logger),
    }
  }
  const standUp = await standUpInfra(dir, infra, opts.signal, logger)
  return {
    ...(standUp.note ? { note: standUp.note } : {}),
    ...(standUp.record ? { record: standUp.record } : {}),
    cleanup: () => tearDownInfra(dir, infra),
  }
}

/**
 * Build the dynamic infra notes appended to the agent's user prompt from a stand-up outcome.
 * A stand-up problem (a failed build / compose) is flagged as a concern to test around; a
 * frontend serve URL points the UI tester at the app that was just built + served and pre-empts
 * a live-backend CORS failure being mis-reported as an app defect. Pure (no IO) so the exact
 * wording + ordering is unit-tested; returns the notes in order (problem first, serve URL next).
 */
export function buildInfraNotes(managed: { note?: string; serveUrl?: string }): string[] {
  const notes: string[] = []
  if (managed.note) {
    notes.push(
      `standing the infra up reported a problem (${managed.note}). Test what you can and ` +
        `flag any dependency-related gaps as concerns.`,
    )
  }
  if (managed.serveUrl) {
    notes.push(
      `The frontend under test is built and served at ${managed.serveUrl}, with its other ` +
        `backend upstreams handled by WireMock. Drive your UI tests against ${managed.serveUrl}. ` +
        `If a call to a live backend fails with a CORS / cross-origin error, that is an infra ` +
        `gap (the backend must allow the ${managed.serveUrl} origin), not an app defect — flag ` +
        `it as a concern rather than a failing test.`,
    )
  }
  return notes
}

/** Tear the docker-compose dependencies down (best-effort; a no-op when none were started). */
async function tearDownInfra(dir: string, infra: ServiceInfraSpec): Promise<void> {
  if (infra.environment !== 'local' || infra.noInfraDependencies || !infra.composePath) return
  try {
    await exec('docker', ['compose', '-f', infra.composePath, 'down', '-v'], {
      cwd: dir,
      timeout: 2 * 60_000,
    })
  } catch {
    // The container is ephemeral and torn down with the run anyway — ignore.
  }
}
