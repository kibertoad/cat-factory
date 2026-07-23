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

import { createHash } from 'node:crypto'

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
  /**
   * Extra in-container ports to publish to a HOST port ALONGSIDE the harness `:8080` (read back
   * via {@link ContainerRuntimeAdapter.endpoint} with the port argument). Used by the
   * browsable-preview transport to reach the served app's port (e.g. 4173). Each entry names the
   * in-`container` port and, optionally, the `host` port to pin it to: an explicit `host` gives a
   * DETERMINISTIC host port knowable ahead of provision (the Docker family publishes it with `-p
   * 127.0.0.1:<host>:<container>`), while an absent `host` takes an ephemeral one (`-p
   * 127.0.0.1:0:<container>`). Apple `container` (per-container IP, no published-port model)
   * ignores this entirely — the port is reachable at the container's own IP.
   */
  publishPorts?: Array<{ container: number; host?: number }>
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
  /**
   * Whether this runtime publishes a container port to the host LOOPBACK (`127.0.0.1`/`localhost`)
   * via a `-p` mapping (the Docker family: Docker/Podman/OrbStack/Colima) rather than reaching the
   * port at the container's own IP (Apple `container`, one VM per container). The browsable-preview
   * transport keys off this: a localhost runtime pins the served-app host port to the serve port and
   * forms a DETERMINISTIC `http://localhost:<servePort>` origin — knowable ahead of provision, so a
   * deployer can fold it into the bound backend's CORS allow-list (see `frontendOriginsForService`).
   * A per-container-IP runtime instead reads the assigned IP after the container is up
   * (`http://<ip>:<servePort>`), which is NOT pre-knowable and so is never injected.
   */
  readonly publishesToLocalhost: boolean

  /** Start a per-run container detached; resolves to its container id/name. */
  run(exec: ContainerExec, spec: RunContainerSpec): Promise<string>
  /** The (running-or-exited) container for a run, if any. */
  find(exec: ContainerExec, runId: string): Promise<string | undefined>
  /**
   * The host+port the orchestrator should connect to reach the container's `inContainerPort`
   * (default {@link HARNESS_PORT}), or undefined if not ready. The preview transport passes the
   * served-app port (published via {@link RunContainerSpec.publishPorts}) to reach the app.
   *
   * "Not ready" INCLUDES a container that has EXITED: {@link find} deliberately returns
   * running-or-exited containers, so every adapter must map a dead one to `undefined` rather
   * than throwing whatever its CLI printed. Callers rely on that — the transport's `resolve()`
   * treats an endpoint-less container as absent and re-creates a fresh one, so an adapter that
   * throws here instead breaks the fresh-container recovery and surfaces a CLI message ("no
   * public port '8080/tcp' published for …") as the run's cause of death, masking the real one.
   *
   * A fault against a container that is still RUNNING is a different thing (a daemon blip, a
   * misconfigured publish) and SHOULD throw: the spin-up path folds it into its fail-fast
   * diagnostic, and swallowing it there would replace a real cause with a bare timeout.
   *
   * When a runtime can't tell the two apart from what its CLI reports, prefer `undefined`: the
   * cost is a lost diagnostic on the spin-up path (which times out and says so), where the cost
   * of throwing is a wedged run that can never replace its own dead container. The Apple adapter
   * is in that position — `container inspect` faults identically for a reaped container and for a
   * runtime problem — while the docker adapter re-checks liveness and honours both halves.
   */
  endpoint(
    exec: ContainerExec,
    containerId: string,
    inContainerPort?: number,
  ): Promise<ContainerEndpoint | undefined>
  /** Whether the container is currently running. */
  isRunning(exec: ContainerExec, containerId: string): Promise<boolean>
  /**
   * A one-line summary of HOW a stopped container ended — exit code, and whether the runtime
   * OOM-killed it — for the mid-run post-mortem. Resolves to `undefined` when the container is
   * still running, was already reaped, or the runtime can't report it. Best-effort: this is a
   * diagnostic, never a lifecycle signal (use {@link isRunning} for that).
   *
   * Worth having beside {@link logs}: a container killed by the runtime's cgroup limit exits
   * with an empty log tail, so the exit state is the ONLY thing separating "OOM-killed" from
   * "the agent process threw and printed nothing".
   */
  exitState(exec: ContainerExec, containerId: string): Promise<string | undefined>
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
  /**
   * Every managed, still-RUNNING per-run container this runtime holds, tagged by its run
   * id. Used at boot to reap containers whose run has since gone terminal/away (their
   * `release()` never ran because the previous process crashed). Exited ones are handled
   * by {@link reapExited}; this covers the ones still up.
   */
  listRunContainers(exec: ContainerExec): Promise<Array<{ runId: string; containerId: string }>>
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

/** The accepted `LOCAL_CONTAINER_RUNTIME` ids, in declaration order (for messages). */
export const RUNTIME_IDS = Object.keys(PROFILES) as RuntimeId[]

/** Resolve the runtime profile for an id (defaults to docker for an unknown value). */
export function runtimeProfile(id: RuntimeId): RuntimeProfile {
  return PROFILES[id] ?? PROFILES.docker
}

/**
 * The runtime selected by `LOCAL_CONTAINER_RUNTIME` (docker | podman | orbstack |
 * colima | apple). Defaults to `docker`; an unrecognised value also falls back to
 * docker (logged by the preflight, see {@link unrecognizedRuntimeId}). Explicit
 * selection is the supported path.
 */
export function resolveRuntimeId(env: NodeJS.ProcessEnv): RuntimeId {
  const raw = env.LOCAL_CONTAINER_RUNTIME?.trim().toLowerCase()
  if (raw && (RUNTIME_IDS as string[]).includes(raw)) return raw as RuntimeId
  return 'docker'
}

/**
 * The raw `LOCAL_CONTAINER_RUNTIME` value when it is SET but not one of the accepted
 * runtime ids — i.e. the typo `resolveRuntimeId` silently fell back to `docker` for.
 * Undefined when the var is unset or valid. The preflight logs this so an unrecognised
 * value is visible at boot instead of silently running docker (error-message coverage A9).
 */
export function unrecognizedRuntimeId(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.LOCAL_CONTAINER_RUNTIME?.trim()
  if (!raw) return undefined
  return (RUNTIME_IDS as string[]).includes(raw.toLowerCase()) ? undefined : raw
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

/**
 * A stable, non-secret per-INSTALLATION id used to NAMESPACE every managed container (via a
 * Docker label / the Apple container name), so a machine running two local installs against ONE
 * container daemon never adopts, reaps, or re-leases a neighbour's container (ADR 0026 D5).
 *
 * Derived as a short fingerprint of `HARNESS_SHARED_SECRET` — the exact axis the isolation
 * protects: a pooled container bakes that secret in at creation, and ONLY an install that shares
 * the secret can authenticate to it, so keying the install id on the secret makes the reaper's
 * rule precisely "adopt iff mutually authenticable" (two installs that genuinely share a secret,
 * e.g. a copied `.env`, are safe to share containers and correctly get the same id). The digest is
 * one-way and truncated, so the label leaks nothing usable about the secret. Falls back to other
 * stable config (the database URL, then the public URL) when the secret is unset, so the id is
 * always defined; `default` is the last resort.
 */
export function resolveInstallId(env: NodeJS.ProcessEnv): string {
  const seed =
    env.HARNESS_SHARED_SECRET?.trim() ||
    env.DATABASE_URL?.trim() ||
    env.PUBLIC_URL?.trim() ||
    'default'
  return createHash('sha256').update(seed).digest('hex').slice(0, 16)
}
