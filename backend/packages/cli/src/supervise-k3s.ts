/**
 * A local Kubernetes cluster as a supervised dependency.
 *
 * WHY. A slept laptop takes the k3s control plane with it, and nothing brings it back. The failure
 * is quiet in the worst way: the container engine's `unless-stopped` policy DOES retry the server
 * node, so `docker ps` shows motion — but the load balancer in front of it boots, fails to resolve
 * its now-missing upstream, exits 0, and is restarted forever. A zero exit code reads as healthy at
 * a glance, so the cluster can sit dead for days while `kubectl` just times out and every
 * environment provisioned through the Local k3s handler fails.
 *
 * WHAT THIS CAN AND CANNOT FIX. A cluster whose containers are merely STOPPED is repairable here:
 * start it, wait for the apiserver. A cluster whose restart is blocked by a wedged cgroup
 * (`runc create failed: ... cgroup.procs: device or resource busy`, the state a suspend can leave
 * behind) is NOT: clearing it requires restarting the container engine itself, which would kill
 * every other container — including the database this same supervisor depends on. So that case is
 * detected and NAMED rather than retried. Looping on it would reproduce exactly the uselessness of
 * the load-balancer restart loop this dependency exists to prevent.
 */

import type { HostShell } from './host-shell.js'
import { hasServerVersion, parseK3dClusters, parseKindClusters } from './k3s-probe.js'
import { contextName } from './k3s-provision.js'
import { OperatorActionRequiredError, type ServiceDependency } from './supervise-runtime.js'

/** The local distributions a supervised cluster can run on. `k3s` proper is a host service, not ours to start. */
export type SupervisedK3sRuntime = 'k3d' | 'kind'

const APISERVER_READY_TIMEOUT_MS = 120_000
const APISERVER_POLL_MS = 3_000
const CLUSTER_START_TIMEOUT_MS = 120_000

/**
 * The cgroup-wedge signature. runc reports it when a dead container's cgroup was never torn down,
 * so the new task cannot be created in it — the state a suspend/resume cycle can leave behind, and
 * the one thing a start command can never talk its way out of.
 */
export function looksLikeCgroupWedge(output: string): boolean {
  const text = output.toLowerCase()
  return (
    text.includes('device or resource busy') ||
    (text.includes('cgroup') && text.includes('unable to apply cgroup configuration'))
  )
}

/** The guidance printed when the wedge is hit — the only sequence that actually clears it. */
const CGROUP_WEDGE_GUIDANCE =
  'the container runtime cannot restart this cluster: a stale cgroup is blocking it ' +
  '(runc: "device or resource busy"). This does NOT clear on its own and no retry will fix it. ' +
  'Restart the container engine (e.g. `docker desktop restart`, or Docker Desktop > Restart), ' +
  'then start the cluster again. Note that this also bounces every other container.'

/**
 * Build the cluster dependency. `reachable` is judged from the apiserver's OWN version — the only
 * signal that survives every intermediate lie (containers up but apiserver not listening, LB up but
 * upstream missing, kubeconfig present but stale).
 */
export function createK3sClusterDependency(
  shell: HostShell,
  opts: {
    cluster: string
    runtime: SupervisedK3sRuntime
    /** Overridable so tests don't wait out the real budget. */
    readyTimeoutMs?: number
    readyPollMs?: number
  },
): ServiceDependency {
  const context = contextName(opts.runtime, opts.cluster)
  const readyTimeoutMs = opts.readyTimeoutMs ?? APISERVER_READY_TIMEOUT_MS
  const readyPollMs = opts.readyPollMs ?? APISERVER_POLL_MS

  const apiserverReachable = async (): Promise<boolean> => {
    const result = await shell.run('kubectl', [
      'version',
      '--output=json',
      '--request-timeout=5s',
      '--context',
      context,
    ])
    // A down apiserver still yields exit 1 plus the client half of the payload, so the parse — not
    // the exit code — is what decides. `hasServerVersion` is true only when the server answered.
    return hasServerVersion(result.stdout)
  }

  /** Is this cluster known to the runtime (i.e. stopped rather than deleted)? */
  const clusterExists = async (): Promise<boolean> => {
    if (opts.runtime === 'k3d') {
      const result = await shell.run('k3d', ['cluster', 'list', '--output', 'json'])
      if (result.code !== 0) return false
      return parseK3dClusters(result.stdout).includes(opts.cluster)
    }
    const result = await shell.run('kind', ['get', 'clusters'])
    if (result.code !== 0) return false
    return parseKindClusters(result.stdout).includes(opts.cluster)
  }

  /**
   * Start a stopped cluster. k3d has a first-class `cluster start`; kind has none — a kind cluster
   * is just its node containers, so they are started directly by their conventional names.
   */
  const startCluster = async (): Promise<{ ok: boolean; output: string }> => {
    if (opts.runtime === 'k3d') {
      const result = await shell.run('k3d', ['cluster', 'start', opts.cluster], {
        timeoutMs: CLUSTER_START_TIMEOUT_MS,
      })
      return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}` }
    }
    const result = await shell.run('docker', ['start', `${opts.cluster}-control-plane`], {
      timeoutMs: CLUSTER_START_TIMEOUT_MS,
    })
    return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}` }
  }

  const waitForApiserver = async (): Promise<boolean> => {
    const deadline = Date.now() + readyTimeoutMs
    while (Date.now() < deadline) {
      if (await apiserverReachable()) return true
      // Not `unref`'d — see the note on `systemClock`: an unref'd timer lets the process exit while
      // this wait is the only thing outstanding, which is exactly mid-recovery.
      await new Promise((resolve) => {
        setTimeout(resolve, readyPollMs)
      })
    }
    return false
  }

  return {
    label: `${opts.runtime} cluster "${opts.cluster}"`,
    async ensure() {
      if (await apiserverReachable()) return true

      // Absent from the runtime's list ⇒ deleted, not stopped. Creating one here would be a
      // surprise (it owns RBAC + a service account); `cat-factory k3s` is the deliberate path.
      if (!(await clusterExists())) return false

      const started = await startCluster()
      if (!started.ok) {
        if (looksLikeCgroupWedge(started.output)) {
          throw new K3sWedgedError(CGROUP_WEDGE_GUIDANCE)
        }
        return false
      }
      return await waitForApiserver()
    },
  }
}

/**
 * Thrown when the cluster cannot be restarted without operator action. Distinct from a plain
 * `false` (not ready, retry next cycle) precisely so the loop can stop repeating a hopeless step
 * and surface the fix instead.
 */
export class K3sWedgedError extends OperatorActionRequiredError {}
