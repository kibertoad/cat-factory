import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
import { configProblem } from '@cat-factory/server'
import { requireHarnessSharedSecret } from './config.js'
import { createRuntimeAdapter } from './runtimes/index.js'
import { LocalContainerRunnerTransport } from './LocalContainerRunnerTransport.js'
import { LocalProcessRunnerTransport } from './LocalProcessRunnerTransport.js'

// The local-mode DEPLOY transport: how a container-backed Kubernetes provision (real
// `kubectl`/`kustomize`/`helm`) runs on a developer's own machine, selected by
// `LOCAL_DEPLOY_RUNTIME` (`native` | `container`). It is the local analogue of the Worker's
// `DeployContainer` and Node's deploy-image runner pool, and is wired as the
// `deployJobClient`'s transport so a kustomize/helm/Gateway-API service stands its
// environment up locally exactly as it does on the other facades.
//
// There is NO implicit default: the two modes differ in both prerequisites AND blast radius, so
// the developer must choose one EXPLICITLY (an unset `LOCAL_DEPLOY_RUNTIME` simply means "no
// Kubernetes test environments here" — deploy stays unwired). Both drive the SAME deploy-harness
// `POST /jobs` + `GET /jobs/{id}` contract:
//   - `native`: the deploy harness runs as a long-lived HOST PROCESS (the
//     `LocalProcessRunnerTransport` machinery), shelling out to the developer's OWN installed
//     `kubectl`/`kustomize`/`helm` against their ambient kubeconfig — no Docker. Needs no
//     published image, but requires `LOCAL_DEPLOY_HARNESS_ENTRY`. SECURITY: the harness runs as a
//     plain host subprocess with the developer's full cluster + file access — the more brittle,
//     higher-privilege mode, which is exactly why it is not the silent default.
//   - `container`: the deploy-harness IMAGE (`LOCAL_DEPLOY_IMAGE`) runs in a per-job container
//     via the same `ContainerRuntimeAdapter` the agent containers use. The deploy job is keyed
//     by its OWN `jobId` (not the run id) so its container can't collide with the run's agent
//     `ExecutionContainer` (which runs the executor-harness image, NOT the k8s CLIs).

/** The native deploy backend: the deploy harness as a host process (no Docker). */
export class NativeCliDeployTransport extends LocalProcessRunnerTransport {}

/**
 * A {@link RunnerTransport} that re-keys every job's `runId` to its own `jobId` before
 * delegating. A deploy job's ref is `{ runId: <executionId>, jobId: <deployerStepJobId> }`,
 * so dispatching it through a per-RUN container backend would address the SAME container the
 * run's agent steps use — which pulls the executor-harness image, not the deploy harness. This
 * wrapper makes the deploy job its own single-job "run" from the backend's view, so its
 * container is labelled/addressed by the deploy `jobId` and stays separate. The harness still
 * keys the job by `jobId`, unchanged.
 */
class JobScopedRunnerTransport implements RunnerTransport {
  constructor(private readonly inner: RunnerTransport) {}

  private rekey(ref: RunnerJobRef): RunnerJobRef {
    return { runId: ref.jobId, jobId: ref.jobId }
  }

  dispatch(
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind?: RunnerDispatchKind,
    options?: RunnerDispatchOptions,
  ): Promise<void> {
    return this.inner.dispatch(this.rekey(ref), spec, kind, options)
  }

  poll(ref: RunnerJobRef): Promise<RunnerJobView> {
    return this.inner.poll(this.rekey(ref))
  }

  release(ref: RunnerJobRef): Promise<void> {
    return this.inner.release?.(this.rekey(ref)) ?? Promise.resolve()
  }
}

/**
 * The shared `summary` for every `LOCAL_DEPLOY_RUNTIME` misconfiguration problem: what the deploy
 * runner is and that it has no default. The per-throw `remedy` names the specific missing variable.
 */
const DEPLOY_RUNTIME_SUMMARY =
  'The local deploy runner that renders + applies a Kubernetes test environment ' +
  '(kubectl/kustomize/helm). It has NO default — LOCAL_DEPLOY_RUNTIME must be set to `native` or ' +
  '`container`, and the chosen mode needs its own mandatory companion variable.'

/**
 * Build the local deploy transport from the environment, or return null when `LOCAL_DEPLOY_RUNTIME`
 * is UNSET — the deploy lifecycle then stays unwired (deploy is simply not used; a render-needing
 * environment config fails loudly at provision time, the synchronous raw-manifest REST path is
 * unaffected). This is the normal state for a local deployment that does not stand Kubernetes test
 * environments up.
 *
 * There is deliberately NO implicit default. `native` is the more brittle, higher-privilege mode
 * (it shells out to the developer's own kubectl/kustomize/helm with full cluster + file access), so
 * it must be chosen EXPLICITLY rather than fallen into. When a mode IS set but its mandatory
 * companion variable is missing — or the value is unrecognised — this THROWS a
 * {@link ConfigValidationError} to BREAK boot on the misconfigured screen, rather than degrading to
 * a silently-unwired deploy the developer only discovers mid-run.
 *
 * - `native`    → requires `LOCAL_DEPLOY_HARNESS_ENTRY` (the deploy-harness server entry path,
 *   spawned as `node <entry>`; a `.ts` entry runs via Node type-stripping). `kubectl`, `kustomize`
 *   and `helm` must be installed on the host.
 * - `container` → requires `LOCAL_DEPLOY_IMAGE` (the deploy-harness image ref). Runs one
 *   cold-started container per deploy job (no warm pool) on the selected `LOCAL_CONTAINER_RUNTIME`.
 */
export function buildLocalDeployTransport(env: NodeJS.ProcessEnv): RunnerTransport | null {
  const rawMode = env.LOCAL_DEPLOY_RUNTIME?.trim().toLowerCase()
  // Unset ⇒ deploy is simply not used (no default, no error). The common state for a local
  // deployment that never provisions Kubernetes test environments.
  if (!rawMode) return null
  if (rawMode !== 'native' && rawMode !== 'container') {
    // A typo used to silently fall back to `native` (and then a silently-unwired deploy). Break
    // instead: an unintelligible mode is a misconfiguration, not a request for the brittle default.
    throw configProblem({
      key: 'LOCAL_DEPLOY_RUNTIME',
      summary: DEPLOY_RUNTIME_SUMMARY,
      remedy:
        `LOCAL_DEPLOY_RUNTIME='${rawMode}' is not a recognised value. Set it to \`native\` ` +
        '(renders with your host kubectl/kustomize/helm; also set LOCAL_DEPLOY_HARNESS_ENTRY) or ' +
        '`container` (runs the deploy-harness image per job; also set LOCAL_DEPLOY_IMAGE), or ' +
        'unset LOCAL_DEPLOY_RUNTIME if this deployment does not provision Kubernetes test environments.',
    })
  }
  if (rawMode === 'container') {
    const image = env.LOCAL_DEPLOY_IMAGE?.trim()
    if (!image) {
      // Container mode was EXPLICITLY selected but its image is missing — break boot rather than
      // leave the deploy lifecycle unwired until the first render fails mid-run.
      throw configProblem({
        key: 'LOCAL_DEPLOY_IMAGE',
        summary: DEPLOY_RUNTIME_SUMMARY,
        remedy:
          'LOCAL_DEPLOY_RUNTIME=container needs LOCAL_DEPLOY_IMAGE — the deploy-harness image ref ' +
          'to run per deploy job (e.g. ghcr.io/kibertoad/cat-factory-deploy:<version>). Set it, ' +
          'switch to LOCAL_DEPLOY_RUNTIME=native (with LOCAL_DEPLOY_HARNESS_ENTRY), or unset ' +
          'LOCAL_DEPLOY_RUNTIME to disable Kubernetes test environments.',
      })
    }
    // poolSize 0: a deploy is one-shot per run, so cold-start its own container and tear it
    // down on release — no warm pool (that's an agent-throughput optimisation). Require the
    // harness secret only now that we're actually building a transport (a deploy-unused env
    // that returns null above must NOT demand it).
    const container = new LocalContainerRunnerTransport({
      image,
      adapter: createRuntimeAdapter(env),
      sharedSecret: requireHarnessSharedSecret(env),
      ...(env.LOCAL_DOCKER_NETWORK?.trim() ? { network: env.LOCAL_DOCKER_NETWORK.trim() } : {}),
      // The deploy harness never nests a docker daemon (it talks to the apiserver over the
      // network), so it never needs the privileged Tester path.
      privilegedTestJobs: false,
    })
    return new JobScopedRunnerTransport(container)
  }
  // Explicit native host process.
  const harnessEntry = env.LOCAL_DEPLOY_HARNESS_ENTRY?.trim()
  if (!harnessEntry) {
    // Native mode was EXPLICITLY selected but its entry is missing — break boot (this is the
    // brittle, must-be-configured mode; a silent unwiring here is the exact trap this rewrite removes).
    throw configProblem({
      key: 'LOCAL_DEPLOY_HARNESS_ENTRY',
      summary: DEPLOY_RUNTIME_SUMMARY,
      remedy:
        'LOCAL_DEPLOY_RUNTIME=native needs LOCAL_DEPLOY_HARNESS_ENTRY — the deploy-harness server ' +
        'entry path, run as `node <entry>` (a .ts entry runs via Node type-stripping). kubectl, ' +
        'kustomize and helm must also be installed on the host. Set it, switch to ' +
        'LOCAL_DEPLOY_RUNTIME=container (with LOCAL_DEPLOY_IMAGE), or unset LOCAL_DEPLOY_RUNTIME to ' +
        'disable Kubernetes test environments.',
    })
  }
  return new NativeCliDeployTransport({
    harnessEntry,
    // Required only on the construction path (the deploy-unused early return above must not).
    sharedSecret: requireHarnessSharedSecret(env),
    // The deploy harness shells out to the developer's kubectl/kustomize/helm, which run on
    // ambient cloud/cluster env (KUBECONFIG, AWS_*, …) — so it inherits the full environment
    // rather than the sanitized agent allow-list.
    envMode: 'inherit',
  })
}
