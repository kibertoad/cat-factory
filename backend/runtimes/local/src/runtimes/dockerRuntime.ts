import {
  type ContainerEndpoint,
  type ContainerExec,
  type ContainerExitState,
  type ContainerRuntimeAdapter,
  formatContainerLogs,
  HARNESS_PORT,
  type RunContainerSpec,
  type RuntimeId,
} from './containerRuntime.js'

// The Docker-CLI adapter — covers Docker, Podman, OrbStack and Colima, which all speak
// the same `run/ps/port/inspect/rm` surface. It is the behaviour the transport had
// inline before the seam was extracted, parameterised by binary + networking. A container
// is labelled with its container key and a managed marker; the harness port is published
// to an ephemeral host port read back with `docker port`.

/**
 * Labels a per-run container by its CONTAINER KEY: the run id for the ordinary one, and the
 * variant-qualified `ui:<runId>` for a step on another executor image. The label NAME still says
 * `runId` (it is written into live containers, so renaming it would orphan every one a running
 * daemon holds); what it carries is the key, which round-trips verbatim through a label.
 */
const LABEL_RUN = 'cat-factory.runId'
const LABEL_MANAGED = 'cat-factory.managed=local-docker'
/** Marks a reusable warm-pool member (not bound to any run id; leased in-process). */
const LABEL_POOL = 'cat-factory.pool=1'
/**
 * NAMESPACES a container by installation (ADR 0026 D5). Every managed container carries
 * `cat-factory.install=<installId>`, and every daemon-wide enumeration filters on it, so a machine
 * running two installs against one Docker daemon never adopts, reaps, or re-leases a container the
 * OTHER install created — critical for the warm pool, whose members bake this install's
 * `HARNESS_SHARED_SECRET` in and would fail authentication if leased by a neighbour.
 */
const LABEL_INSTALL = 'cat-factory.install'

export interface DockerRuntimeAdapterOptions {
  id: RuntimeId
  binary: string
  hostAlias: string
  /** Add `--add-host=<hostAlias>:host-gateway` so the harness can reach the host. */
  addHostGateway: boolean
  localDind: boolean
  /** Whether the warm-container pool is supported (Docker-family: true). */
  pooling: boolean
  /** Stable per-installation id namespacing this install's containers (see {@link LABEL_INSTALL}). */
  installId: string
}

export class DockerRuntimeAdapter implements ContainerRuntimeAdapter {
  readonly id: RuntimeId
  readonly binary: string
  readonly hostAlias: string
  readonly capabilities: { localDind: boolean; pooling: boolean }
  // Docker/Podman/OrbStack/Colima all forward published ports to the host loopback, so a
  // preview's served-app port is reachable (and pinnable) on localhost.
  readonly publishesToLocalhost = true
  // `--add-host` takes both target forms: the `host-gateway` token this family resolves itself,
  // and a plain address.
  readonly honoursHostBridges = true
  private readonly addHostGateway: boolean
  private readonly installId: string

  constructor(options: DockerRuntimeAdapterOptions) {
    this.id = options.id
    this.binary = options.binary
    this.hostAlias = options.hostAlias
    this.addHostGateway = options.addHostGateway
    this.installId = options.installId
    this.capabilities = { localDind: options.localDind, pooling: options.pooling }
  }

  /** The `--filter` pair scoping a daemon-wide enumeration to THIS install's containers. */
  private installFilter(): string[] {
    return ['--filter', `label=${LABEL_INSTALL}=${this.installId}`]
  }

  async run(exec: ContainerExec, spec: RunContainerSpec): Promise<string> {
    // A pool member is labelled `pool=1` and NOT bound to a container key (the transport leases
    // it in-process); a classic per-run container is labelled by its key. Every container also
    // carries the per-install label so a neighbouring install can't adopt/reap/reuse it.
    const args = [
      'run',
      '-d',
      '--label',
      spec.pool ? LABEL_POOL : `${LABEL_RUN}=${spec.containerKey}`,
      '--label',
      LABEL_MANAGED,
      '--label',
      `${LABEL_INSTALL}=${this.installId}`,
      '-p',
      `127.0.0.1:0:${HARNESS_PORT}`,
      '-e',
      `HARNESS_SHARED_SECRET=${spec.sharedSecret}`,
    ]
    // Extra published ports (the preview transport's served-app port) alongside the harness
    // port. A pinned `host` gives a deterministic, pre-knowable host port (the preview origin);
    // an absent one takes an ephemeral port read back via `endpoint(id, port)`.
    for (const p of spec.publishPorts ?? [])
      args.push('-p', `127.0.0.1:${p.host ?? 0}:${p.container}`)
    if (spec.instanceSize)
      args.push('--memory', spec.instanceSize.memory, '--cpus', spec.instanceSize.cpus)
    if (spec.privileged) args.push('--privileged')
    if (this.addHostGateway) args.push(`--add-host=${this.hostAlias}:host-gateway`)
    // Per-job host bridges (the ephemeral-environment host). Emitted whether or not the standing
    // `hostAlias` add-host is: `addHostGateway` is false where a runtime resolves its OWN alias
    // natively (Colima's `host.lima.internal`), which says nothing about a name the runtime has
    // never heard of. `host-gateway` is a Docker-family token and this is the Docker-family adapter;
    // the address form is ordinary `--add-host` and is what a remote environment whose name lives
    // in a DNS view we cannot see takes. The target is NEVER interpolated raw from a provider: it
    // arrives already graded by kernel's `isBridgeableAddress`.
    for (const bridge of spec.extraHosts ?? []) {
      const target = bridge.target === 'host-gateway' ? 'host-gateway' : bridge.target.ip
      args.push(`--add-host=${bridge.host}:${target}`)
    }
    if (spec.network) args.push('--network', spec.network)
    for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`)
    // The port the harness must BIND, stated rather than left to whatever the image defaults to,
    // and emitted last so neither a job's own `env` nor an image default can disagree with the
    // `-p` above. Without it the published port and the served one are joined only by the image
    // being the version this backend was built against: an operator-pinned older harness (a
    // SUPPORTED, warn-level configuration) binds its own default, nothing answers on the port the
    // transport addresses, and the version handshake that would name the skew never runs because
    // it needs a reachable harness. The failure surfaced as a bare ready-timeout instead. The
    // Kubernetes pod spec has always stated it this way (`buildPodManifest`'s `env`).
    args.push('-e', `PORT=${HARNESS_PORT}`)
    args.push(spec.image)

    const { stdout } = await exec(args)
    const containerId = stdout.trim().split(/\s+/).pop()
    if (!containerId) throw new Error(`${this.binary} run returned no container id`)
    return containerId
  }

  async find(exec: ContainerExec, containerKey: string): Promise<string | undefined> {
    const { stdout } = await exec([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_RUN}=${containerKey}`,
      '--filter',
      `label=${LABEL_MANAGED}`,
      ...this.installFilter(),
    ])
    return stdout.trim().split('\n')[0]?.trim() || undefined
  }

  async endpoint(
    exec: ContainerExec,
    containerId: string,
    inContainerPort: number = HARNESS_PORT,
  ): Promise<ContainerEndpoint | undefined> {
    // `docker port` EXITS NON-ZERO for a container that isn't running ("no public port
    // '<port>/tcp' published for <id>"), and `find()` hands us exited containers by design. A
    // dead container is "not ready" per the port contract, so it must resolve to undefined:
    // a throw escapes `dispatchPerRun`'s `resolve()` and skips the remove-and-recreate
    // recovery an exited container exists to trigger, surfacing the CLI's message as the
    // run's cause of death instead. Anything else that faults IS worth reporting (a daemon
    // blip against a live container), so only a confirmed-dead container is swallowed —
    // `waitForEndpoint` folds a genuine error into its fail-fast spin-up diagnostic.
    let stdout: string
    try {
      ;({ stdout } = await exec(['port', containerId, `${inContainerPort}/tcp`]))
    } catch (err) {
      if (await this.isRunning(exec, containerId)) throw err
      return undefined
    }
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

  async exitState(
    exec: ContainerExec,
    containerId: string,
  ): Promise<ContainerExitState | undefined> {
    // `OOMKilled` is only ever true for a CGROUP-limit kill (a `--memory` cap). A container
    // with no cap that the VM's own OOM killer reaps reports a plain non-zero exit code, so
    // read both rather than treating a false `OOMKilled` as "not a memory problem".
    const inspected = await exec([
      'inspect',
      '-f',
      '{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}',
      containerId,
    ]).catch(() => undefined)
    if (!inspected) return undefined
    const [running, exitCode, oomKilled] = inspected.stdout.trim().split(/\s+/)
    if (running !== 'false') return undefined
    // Parsed, not just rendered: a `0` here is what tells a harness that was SHUT DOWN mid-job
    // apart from one that crashed. A field docker did not print stays undefined rather than
    // becoming a number, so "unknown" can never read as "clean".
    const code = Number(exitCode)
    return {
      description: `exit code ${exitCode ?? 'unknown'}${oomKilled === 'true' ? ', OOM-killed by the container runtime' : ''}`,
      ...(exitCode !== undefined && Number.isInteger(code) ? { code } : {}),
    }
  }

  async logs(exec: ContainerExec, containerId: string): Promise<string> {
    try {
      const { stdout, stderr } = await exec(['logs', '--tail', '50', containerId])
      return formatContainerLogs(stdout, stderr)
    } catch {
      return ''
    }
  }

  async remove(exec: ContainerExec, containerId: string): Promise<void> {
    await exec(['rm', '-f', containerId]).catch(() => undefined)
  }

  async removeRun(exec: ContainerExec, containerKey: string): Promise<void> {
    const { stdout } = await exec([
      'ps',
      '-aq',
      '--filter',
      `label=${LABEL_RUN}=${containerKey}`,
      '--filter',
      `label=${LABEL_MANAGED}`,
      ...this.installFilter(),
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
      ...this.installFilter(),
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
      ...this.installFilter(),
      '--filter',
      `label=${LABEL_POOL}`,
    ])
    return stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  async listRunContainers(
    exec: ContainerExec,
  ): Promise<Array<{ containerKey: string; containerId: string }>> {
    // Running (not exited) per-run containers, printed as "<containerKey>|<containerId>" so we
    // get both the key label and the id in one call. `status=running` excludes what reapExited
    // already handles; the key label excludes pool members (which carry `pool=1` instead). The
    // key rides a LABEL, so it round-trips verbatim however it is spelled.
    const { stdout } = await exec([
      'ps',
      '--filter',
      `label=${LABEL_MANAGED}`,
      ...this.installFilter(),
      '--filter',
      `label=${LABEL_RUN}`,
      '--filter',
      'status=running',
      '--format',
      `{{.Label "${LABEL_RUN}"}}|{{.ID}}`,
    ])
    return stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const sep = line.indexOf('|')
        return { containerKey: line.slice(0, sep), containerId: line.slice(sep + 1) }
      })
      .filter((c) => c.containerKey && c.containerId)
  }
}
