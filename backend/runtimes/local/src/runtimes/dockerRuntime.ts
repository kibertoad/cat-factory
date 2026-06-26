import {
  type ContainerEndpoint,
  type ContainerExec,
  type ContainerRuntimeAdapter,
  HARNESS_PORT,
  type RunContainerSpec,
  type RuntimeId,
} from './containerRuntime.js'

// The Docker-CLI adapter — covers Docker, Podman, OrbStack and Colima, which all speak
// the same `run/ps/port/inspect/rm` surface. It is the behaviour the transport had
// inline before the seam was extracted, parameterised by binary + networking. A run's
// container is labelled with the run id (the container key) and a managed marker; the
// harness `:8080` is published to an ephemeral host port read back with `docker port`.

/** Labels the per-run container by its run id (a run's steps share one container). */
const LABEL_RUN = 'cat-factory.runId'
const LABEL_MANAGED = 'cat-factory.managed=local-docker'
/** Marks a reusable warm-pool member (not bound to any run id; leased in-process). */
const LABEL_POOL = 'cat-factory.pool=1'

export interface DockerRuntimeAdapterOptions {
  id: RuntimeId
  binary: string
  hostAlias: string
  /** Add `--add-host=<hostAlias>:host-gateway` so the harness can reach the host. */
  addHostGateway: boolean
  localDind: boolean
  /** Whether the warm-container pool is supported (Docker-family: true). */
  pooling: boolean
}

export class DockerRuntimeAdapter implements ContainerRuntimeAdapter {
  readonly id: RuntimeId
  readonly binary: string
  readonly hostAlias: string
  readonly capabilities: { localDind: boolean; pooling: boolean }
  private readonly addHostGateway: boolean

  constructor(options: DockerRuntimeAdapterOptions) {
    this.id = options.id
    this.binary = options.binary
    this.hostAlias = options.hostAlias
    this.addHostGateway = options.addHostGateway
    this.capabilities = { localDind: options.localDind, pooling: options.pooling }
  }

  async run(exec: ContainerExec, spec: RunContainerSpec): Promise<string> {
    // A pool member is labelled `pool=1` and NOT bound to a run id (the transport leases
    // it in-process); a classic per-run container is labelled by its run id.
    const args = [
      'run',
      '-d',
      '--label',
      spec.pool ? LABEL_POOL : `${LABEL_RUN}=${spec.runId}`,
      '--label',
      LABEL_MANAGED,
      '-p',
      `127.0.0.1:0:${HARNESS_PORT}`,
      '-e',
      `HARNESS_SHARED_SECRET=${spec.sharedSecret}`,
    ]
    if (spec.instanceSize)
      args.push('--memory', spec.instanceSize.memory, '--cpus', spec.instanceSize.cpus)
    if (spec.privileged) args.push('--privileged')
    if (this.addHostGateway) args.push(`--add-host=${this.hostAlias}:host-gateway`)
    if (spec.network) args.push('--network', spec.network)
    for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`)
    args.push(spec.image)

    const { stdout } = await exec(args)
    const containerId = stdout.trim().split(/\s+/).pop()
    if (!containerId) throw new Error(`${this.binary} run returned no container id`)
    return containerId
  }

  async find(exec: ContainerExec, runId: string): Promise<string | undefined> {
    const { stdout } = await exec([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_RUN}=${runId}`,
      '--filter',
      `label=${LABEL_MANAGED}`,
    ])
    return stdout.trim().split('\n')[0]?.trim() || undefined
  }

  async endpoint(exec: ContainerExec, containerId: string): Promise<ContainerEndpoint | undefined> {
    const { stdout } = await exec(['port', containerId, `${HARNESS_PORT}/tcp`])
    // e.g. "127.0.0.1:49153" (possibly several lines for IPv4/IPv6); take the last
    // numeric segment of the first line.
    const line = stdout.trim().split('\n')[0]?.trim()
    if (!line) return undefined
    const port = Number(line.slice(line.lastIndexOf(':') + 1))
    if (!Number.isFinite(port) || port <= 0) return undefined
    return { host: '127.0.0.1', port }
  }

  async isRunning(exec: ContainerExec, containerId: string): Promise<boolean> {
    try {
      const { stdout } = await exec(['inspect', '-f', '{{.State.Running}}', containerId])
      return stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  async remove(exec: ContainerExec, containerId: string): Promise<void> {
    await exec(['rm', '-f', containerId]).catch(() => undefined)
  }

  async removeRun(exec: ContainerExec, runId: string): Promise<void> {
    const { stdout } = await exec([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_RUN}=${runId}`,
      '--filter',
      `label=${LABEL_MANAGED}`,
    ])
    const ids = stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length) await exec(['rm', '-f', ...ids]).catch(() => undefined)
  }

  async reapExited(exec: ContainerExec): Promise<number> {
    const { stdout } = await exec([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_MANAGED}`,
      '--filter',
      'status=exited',
    ])
    const ids = stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length) await exec(['rm', '-f', ...ids]).catch(() => undefined)
    return ids.length
  }

  async listPoolMembers(exec: ContainerExec): Promise<string[]> {
    const { stdout } = await exec([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_MANAGED}`,
      '--filter',
      `label=${LABEL_POOL}`,
    ])
    return stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }
}
