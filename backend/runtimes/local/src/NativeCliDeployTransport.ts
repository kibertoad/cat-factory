import type {
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunnerTransport,
} from '@cat-factory/kernel'
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
// Two modes, both driving the SAME deploy-harness `POST /jobs` + `GET /jobs/{id}` contract:
//   - `native` (default): the deploy harness runs as a long-lived HOST PROCESS (the
//     `LocalProcessRunnerTransport` machinery), shelling out to the developer's OWN installed
//     `kubectl`/`kustomize`/`helm` against their ambient kubeconfig — no Docker. This is the
//     natural local path (a dev deploys to their own kind/k3d/cluster) and needs no published
//     image. SECURITY: the harness runs as a plain host subprocess with the developer's full
//     cluster + file access — acceptable only because local mode is their own machine.
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
 * Build the local deploy transport from the environment, or return null when its mode's
 * prerequisite isn't configured (so the deploy lifecycle stays unwired — a render-needing
 * config then fails loudly, the synchronous raw-manifest REST path is unaffected). Default
 * mode is `native`.
 *
 * - `native`  → requires `LOCAL_DEPLOY_HARNESS_ENTRY` (the deploy-harness server entry path,
 *   spawned as `node <entry>`; a `.ts` entry runs via Node type-stripping). `kubectl`,
 *   `kustomize` and `helm` must be installed on the host.
 * - `container` → requires `LOCAL_DEPLOY_IMAGE` (the deploy-harness image ref). Runs one
 *   cold-started container per deploy job (no warm pool) on the selected `LOCAL_CONTAINER_RUNTIME`.
 */
export function buildLocalDeployTransport(
  env: NodeJS.ProcessEnv,
  onWarn?: (message: string) => void,
): RunnerTransport | null {
  const rawMode = env.LOCAL_DEPLOY_RUNTIME?.trim().toLowerCase()
  const mode = rawMode || 'native'
  // A typo'd mode would otherwise silently become `native` — and then, with no
  // LOCAL_DEPLOY_HARNESS_ENTRY, a silently-unwired deploy lifecycle. Keep the fail-safe
  // fallback, but say so.
  if (rawMode && rawMode !== 'native' && rawMode !== 'container') {
    onWarn?.(
      `LOCAL_DEPLOY_RUNTIME: unrecognized value '${rawMode}' (expected native | container) — ` +
        `using the native default`,
    )
  }
  if (mode === 'container') {
    const image = env.LOCAL_DEPLOY_IMAGE?.trim()
    if (!image) {
      // Container mode was EXPLICITLY selected, so an unwired deploy is a misconfiguration,
      // not the deploy-unused default — surface it instead of failing only at render time.
      onWarn?.(
        'LOCAL_DEPLOY_RUNTIME=container needs LOCAL_DEPLOY_IMAGE — the deploy lifecycle ' +
          'stays unwired (environment configs that need a render will fail).',
      )
      return null
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
  // Default: native host process.
  const harnessEntry = env.LOCAL_DEPLOY_HARNESS_ENTRY?.trim()
  if (!harnessEntry) {
    // Only warn when the mode was EXPLICITLY set: an unset LOCAL_DEPLOY_RUNTIME with no
    // entry is simply "deploy not used", the normal state for most local deployments.
    if (rawMode) {
      onWarn?.(
        'LOCAL_DEPLOY_RUNTIME=native needs LOCAL_DEPLOY_HARNESS_ENTRY (the deploy-harness ' +
          'server entry path) — the deploy lifecycle stays unwired (environment configs ' +
          'that need a render will fail).',
      )
    }
    return null
  }
  return new NativeCliDeployTransport({
    harnessEntry,
    // Required only on the construction path (the deploy-unused early returns above must not).
    sharedSecret: requireHarnessSharedSecret(env),
    // The deploy harness shells out to the developer's kubectl/kustomize/helm, which run on
    // ambient cloud/cluster env (KUBECONFIG, AWS_*, …) — so it inherits the full environment
    // rather than the sanitized agent allow-list.
    envMode: 'inherit',
  })
}
