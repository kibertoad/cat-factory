// The local-mode container-runtime seam. `LocalContainerRunnerTransport` orchestrates
// the per-run container lifecycle (cache, health polling, HTTP) but delegates every
// CLI call and the "how do I reach this container / how does it reach the host"
// decision to a `ContainerRuntimeAdapter`, so a runtime that diverges from the Docker
// CLI (today: Apple's `container`, which runs each container in its own VM with its own
// IP and speaks a different CLI) is a new adapter rather than a fork of the transport.
//
// Docker, Podman, OrbStack and Colima all speak the Docker CLI, so they share ONE
// adapter (`DockerRuntimeAdapter`) parameterised by binary + networking. Apple
// `container` gets its own (`AppleContainerRuntimeAdapter`).

/** The in-container port the executor-harness listens on. */
export const HARNESS_PORT = 8080

/** Injectable CLI runner (docker/podman/container) — overridable in tests. */
export type ContainerExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

/**
 * Shape a container's captured `logs` output into a short tail for a fail-fast spin-up
 * error: trim + drop empty stdout/stderr, join with newlines, and (when the CLI can't
 * `--tail` itself, e.g. Apple `container`) keep only the last `tailLines`. Shared by the
 * adapters' `logs()` impls so they can't drift in how they shape the tail.
 */
export function formatContainerLogs(stdout: string, stderr: string, tailLines?: number): string {
  const out = [stdout, stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
  return tailLines ? out.split('\n').slice(-tailLines).join('\n') : out
}

/** Where the orchestrator connects to reach a run's harness. */
export interface ContainerEndpoint {
  host: string
  port: number
}

/** What a runtime can and cannot do, consumed by the engine's Tester gate. */
export interface RuntimeCapabilities {
  /**
   * Whether the runtime can stand the Tester's local docker-compose infra up via
   * Docker-in-Docker (a privileged / nested-container daemon inside the job
   * container). False for one-VM-per-container runtimes (Apple `container`), which
   * drives the engine's Tester "limited mode".
   */
  localDind: boolean
  /**
   * Whether this runtime supports the warm-container POOL: keeping idle harness
   * containers around and re-leasing them to runs (with repo-affinity checkout reuse)
   * instead of cold-starting one per run. True for the Docker-family adapters; false for
   * Apple `container` (one-VM-per-container, where the deterministic-name identity makes
   * re-leasing messy) — there the transport keeps the per-run path even when a pool size
   * is configured.
   */
  pooling: boolean
}

/** A container to start — per-run, or a reusable POOL member when `pool` is set. */
export interface RunContainerSpec {
  /**
   * For a per-run container this is the run id (the container key + label). For a POOL
   * member it is a synthetic member id used only for the container name — the member is
   * NOT labelled with it (lease state lives in the transport), so a label lookup never
   * finds it; the transport tracks `containerId → {repo, leasedTo}` in-process instead.
   */
  runId: string
  image: string
  sharedSecret: string
  /** Run privileged (only the Tester `test` kind, only when the runtime supports DinD). */
  privileged: boolean
  /** Optional `--network` (docker family only). */
  network?: string
  /** Extra `-e KEY=VALUE` env passed into the container. */
  env: Record<string, string>
  /** Host resource limits derived from the service's abstract instance size. */
  instanceSize?: { memory: string; cpus: string }
  /**
   * Start this as a warm-POOL member: label it `cat-factory.pool=1` (not the run id) so
   * it can be re-leased to any run and enumerated by {@link ContainerRuntimeAdapter.listPoolMembers}.
   * Absent ⇒ the classic per-run container (labelled by run id).
   */
  pool?: boolean
}

/**
 * A container runtime as the transport sees it. Each method takes the injected
 * {@link ContainerExec} so the transport stays runtime-agnostic and tests can drive a
 * fake CLI. Implementations own their own container-identity scheme (labels vs names)
 * and their own networking model (published host port vs per-container IP).
 */
export interface ContainerRuntimeAdapter {
  readonly id: RuntimeId
  readonly binary: string
  readonly capabilities: RuntimeCapabilities
  /** The hostname the harness uses to reach the orchestrator's LLM proxy (for PUBLIC_URL). */
  readonly hostAlias: string

  /** Start a per-run container detached; resolves to its container id/name. */
  run(exec: ContainerExec, spec: RunContainerSpec): Promise<string>
  /** The (running-or-exited) container for a run, if any. */
  find(exec: ContainerExec, runId: string): Promise<string | undefined>
  /** The host+port the orchestrator should connect to, or undefined if not ready. */
  endpoint(exec: ContainerExec, containerId: string): Promise<ContainerEndpoint | undefined>
  /** Whether the container is currently running. */
  isRunning(exec: ContainerExec, containerId: string): Promise<boolean>
  /**
   * A short tail of the container's logs (stdout+stderr), best-effort — resolves to `''`
   * on any error or when the runtime can't read them. Used to explain WHY a container
   * exited during boot (image entrypoint crash, missing env, OOM) so a fail-fast spin-up
   * error carries the root cause instead of a bare timeout.
   */
  logs(exec: ContainerExec, containerId: string): Promise<string>
  /** Force-remove a single container (idempotent). */
  remove(exec: ContainerExec, containerId: string): Promise<void>
  /** Force-remove every container for a run (idempotent). */
  removeRun(exec: ContainerExec, runId: string): Promise<void>
  /** Reap exited managed containers left by crashes; resolves to the count removed. */
  reapExited(exec: ContainerExec): Promise<number>
  /**
   * The container ids of every managed POOL member (running or exited) this runtime
   * holds. Used at boot to drain pool members orphaned by a previous process. Returns []
   * on a runtime that doesn't support pooling.
   */
  listPoolMembers(exec: ContainerExec): Promise<string[]>
}

export type RuntimeId = 'docker' | 'podman' | 'orbstack' | 'colima' | 'apple'

/** Per-runtime defaults — the single source of truth for binary + networking + capability. */
export interface RuntimeProfile {
  id: RuntimeId
  /** Default CLI binary (overridable via LOCAL_DOCKER_BINARY). */
  binary: string
  /** Default host alias used for PUBLIC_URL + the docker `--add-host` line. */
  hostAlias: string
  /** Whether the docker-family adapter adds `--add-host=<alias>:host-gateway`. */
  addHostGateway: boolean
  /** Whether the Tester's local Docker-in-Docker infra can run on this runtime. */
  localDind: boolean
  /** Whether the warm-container pool is supported on this runtime. */
  pooling: boolean
  /** Which adapter implementation backs this runtime. */
  family: 'docker' | 'apple'
}

const PROFILES: Record<RuntimeId, RuntimeProfile> = {
  // Docker Desktop / Engine — the baseline. Desktop resolves host.docker.internal
  // natively; Linux Engine needs the host-gateway add-host (harmless on Desktop).
  docker: {
    id: 'docker',
    binary: 'docker',
    hostAlias: 'host.docker.internal',
    addHostGateway: true,
    localDind: true,
    pooling: true,
    family: 'docker',
  },
  // Podman speaks the same CLI; host.docker.internal:host-gateway works on v4+. Rootless
  // Podman nests containers without --privileged (set LOCAL_DOCKER_PRIVILEGED_TEST_JOBS=false).
  // NOTE: Podman needs fully-qualified image refs (ghcr.io/…, localhost/…).
  podman: {
    id: 'podman',
    binary: 'podman',
    hostAlias: 'host.docker.internal',
    addHostGateway: true,
    localDind: true,
    pooling: true,
    family: 'docker',
  },
  // OrbStack ships a drop-in `docker` CLI and resolves host.docker.internal natively;
  // published ports forward to the host loopback. Works like Docker Desktop.
  orbstack: {
    id: 'orbstack',
    binary: 'docker',
    hostAlias: 'host.docker.internal',
    addHostGateway: true,
    localDind: true,
    pooling: true,
    family: 'docker',
  },
  // Colima runs dockerd in a Lima VM. Ports forward to the host loopback, but
  // host.docker.internal/host-gateway resolves to the VM, not the Mac host where the
  // orchestrator runs — so the harness often can't reach the LLM proxy with the default
  // alias. host.lima.internal is the Lima-provided host alias; if it still doesn't
  // resolve, set PUBLIC_URL to the Mac's LAN IP (see deploy/local/README.md).
  colima: {
    id: 'colima',
    binary: 'docker',
    hostAlias: 'host.lima.internal',
    addHostGateway: false,
    localDind: true,
    pooling: true,
    family: 'docker',
  },
  // Apple `container` (macOS): one lightweight VM per container, each with its own IP.
  // No published-port model (reach the container by IP), no host.docker.internal, and
  // no Docker-in-Docker — so the Tester's local infra mode is unavailable (limited mode).
  // The default host alias is the macOS Virtualization-framework vmnet gateway; override
  // via PUBLIC_URL / LOCAL_HARNESS_HOST_ALIAS if your subnet differs.
  apple: {
    id: 'apple',
    binary: 'container',
    hostAlias: '192.168.64.1',
    addHostGateway: false,
    localDind: false,
    pooling: false,
    family: 'apple',
  },
}

const RUNTIME_IDS = Object.keys(PROFILES) as RuntimeId[]

/** Resolve the runtime profile for an id (defaults to docker for an unknown value). */
export function runtimeProfile(id: RuntimeId): RuntimeProfile {
  return PROFILES[id] ?? PROFILES.docker
}

/**
 * The runtime selected by `LOCAL_CONTAINER_RUNTIME` (docker | podman | orbstack |
 * colima | apple). Defaults to `docker`; an unrecognised value also falls back to
 * docker (logged by the preflight). Explicit selection is the supported path.
 */
export function resolveRuntimeId(env: NodeJS.ProcessEnv): RuntimeId {
  const raw = env.LOCAL_CONTAINER_RUNTIME?.trim().toLowerCase()
  if (raw && (RUNTIME_IDS as string[]).includes(raw)) return raw as RuntimeId
  return 'docker'
}

/**
 * The effective host alias for the chosen runtime: an explicit `LOCAL_HARNESS_HOST_ALIAS`
 * wins, else the runtime profile's default. Used to derive the PUBLIC_URL default so a
 * job container can reach this service's LLM proxy on the host.
 */
export function resolveHostAlias(env: NodeJS.ProcessEnv): string {
  const explicit = env.LOCAL_HARNESS_HOST_ALIAS?.trim()
  if (explicit) return explicit
  return runtimeProfile(resolveRuntimeId(env)).hostAlias
}
