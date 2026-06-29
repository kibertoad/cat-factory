import {
  type ContainerEndpoint,
  type ContainerExec,
  type ContainerRuntimeAdapter,
  HARNESS_PORT,
  type RunContainerSpec,
} from './containerRuntime.js'

// The Apple `container` adapter (macOS Containerization framework). It diverges from the
// Docker CLI in three ways that the seam absorbs:
//   1. Verbs: `container run | list | inspect | delete` (no `ps`/`rm`, no `--filter`,
//      no `inspect -f` template) — so we list-all + filter client-side and parse JSON.
//   2. Identity: `--name` IS the container id, so a run is addressed by a deterministic
//      name (`cf-<runId>`); a managed label marks ours for reaping.
//   3. Networking: each container runs in its own VM with its own IP — there is no
//      published-port-on-loopback, so the orchestrator connects to `<containerIP>:8080`
//      directly (read from `container inspect`). There is no Docker-in-Docker, so
//      `capabilities.localDind` is false (the engine refuses the Tester's local infra
//      mode on this runtime — see ExecutionService limited-mode gating).
//
// CLI flags verified against apple/container's command reference (run -d/-e/-l/--name/
// -c/-m, list --all --format json, inspect, delete --force). The inspect JSON shape for
// the assigned IP is not contractually documented, so the IP/state extraction is
// deliberately tolerant (and unit-tested against the observed shape).

const NAME_PREFIX = 'cf-'
const LABEL_MANAGED = 'cat-factory.managed=apple'

/**
 * Statuses we treat as terminal — i.e. safe to reap. A container whose status we can't
 * recognise (empty/unknown — the `container list` JSON shape is not contractual) is left
 * ALONE rather than risk force-deleting one that is still running.
 */
const TERMINAL_STATUSES = new Set(['stopped', 'exited', 'dead'])

/** The deterministic container name (== id) for a run. */
function runName(runId: string): string {
  // Container names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*; run ids are already in that set,
  // but sanitise defensively so an unusual id can't produce an invalid name.
  return `${NAME_PREFIX}${runId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`
}

interface ListEntry {
  id: string
  /** The assigned `--name`, when the CLI reports it separately from `id`. */
  name?: string
  status: string
}

/** Whether a listed container is one we manage (matched on either the id or the name). */
function isManaged(row: ListEntry): boolean {
  return row.id.startsWith(NAME_PREFIX) || (row.name?.startsWith(NAME_PREFIX) ?? false)
}

/** Parse `container list --format json` into a normalised {id,name,status} list, tolerantly. */
function parseList(stdout: string): ListEntry[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const out: ListEntry[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const obj = row as Record<string, unknown>
    const config = (obj.configuration ?? obj.config) as Record<string, unknown> | undefined
    const name = asString(obj.name) ?? asString(config?.name)
    const id = asString(obj.id) ?? asString(config?.id) ?? name
    const status = (asString(obj.status) ?? asString(obj.state) ?? '').toLowerCase()
    if (id) out.push({ id, name, status })
  }
  return out
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** First plausible non-gateway IPv4 found anywhere in the inspect JSON, CIDR-stripped. */
function extractIp(node: unknown, keyHint = ''): string | undefined {
  if (typeof node === 'string') {
    if (/gateway/i.test(keyHint)) return undefined
    const m = node.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\/\d+)?\b/)
    return m?.[1]
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = extractIp(item, keyHint)
      if (found) return found
    }
    return undefined
  }
  if (typeof node === 'object' && node !== null) {
    // Prefer explicit address-bearing fields over a blind scan.
    for (const key of ['address', 'ipAddress', 'ip', 'ipv4']) {
      const v = (node as Record<string, unknown>)[key]
      const found = extractIp(v, key)
      if (found) return found
    }
    for (const [key, v] of Object.entries(node as Record<string, unknown>)) {
      const found = extractIp(v, key)
      if (found) return found
    }
  }
  return undefined
}

/** Parse `container inspect` output (array or object) into {ip?, running}. */
function parseInspect(stdout: string): { ip?: string; running: boolean } {
  const trimmed = stdout.trim()
  if (!trimmed) return { running: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { running: false }
  }
  const node = Array.isArray(parsed) ? parsed[0] : parsed
  if (typeof node !== 'object' || node === null) return { running: false }
  const obj = node as Record<string, unknown>
  const status = (asString(obj.status) ?? asString(obj.state) ?? '').toLowerCase()
  return { ip: extractIp(obj), running: status === 'running' }
}

export class AppleContainerRuntimeAdapter implements ContainerRuntimeAdapter {
  readonly id = 'apple' as const
  readonly binary: string
  readonly hostAlias: string
  // One-VM-per-container with a deterministic-name identity: no Docker-in-Docker, and the
  // warm pool isn't supported (re-leasing a name-keyed VM is messy) — so the transport
  // keeps the per-run path here even when a pool size is configured.
  readonly capabilities = { localDind: false, pooling: false }

  constructor(options: { binary?: string; hostAlias: string }) {
    this.binary = options.binary ?? 'container'
    this.hostAlias = options.hostAlias
  }

  async run(exec: ContainerExec, spec: RunContainerSpec): Promise<string> {
    const name = runName(spec.runId)
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '-l',
      LABEL_MANAGED,
      '-e',
      `HARNESS_SHARED_SECRET=${spec.sharedSecret}`,
    ]
    // No published port (connect by the container's own IP) and no --privileged
    // (one-VM-per-container has no Docker-in-Docker; the engine never asks the Tester to
    // run local infra here — see capabilities.localDind=false).
    if (spec.instanceSize) args.push('-m', spec.instanceSize.memory, '-c', spec.instanceSize.cpus)
    for (const [k, v] of Object.entries(spec.env)) args.push('-e', `${k}=${v}`)
    args.push(spec.image)
    await exec(args)
    // The name IS the container id; the transport addresses everything by it.
    return name
  }

  async find(exec: ContainerExec, runId: string): Promise<string | undefined> {
    const name = runName(runId)
    const rows = parseList((await exec(['list', '--all', '--format', 'json'])).stdout)
    // The deterministic name is the addressable handle (inspect/delete accept it). Match it
    // against either the `id` or the `name` field, since `container list`'s `id` may be a
    // content hash rather than the assigned name depending on the CLI version.
    const hit = rows.find((r) => r.id === name || r.name === name)
    return hit ? name : undefined
  }

  async endpoint(exec: ContainerExec, containerId: string): Promise<ContainerEndpoint | undefined> {
    const { ip } = parseInspect((await exec(['inspect', containerId])).stdout)
    if (!ip) return undefined
    return { host: ip, port: HARNESS_PORT }
  }

  async isRunning(exec: ContainerExec, containerId: string): Promise<boolean> {
    try {
      return parseInspect((await exec(['inspect', containerId])).stdout).running
    } catch {
      return false
    }
  }

  async logs(exec: ContainerExec, containerId: string): Promise<string> {
    try {
      const { stdout, stderr } = await exec(['logs', containerId])
      const out = [stdout, stderr]
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n')
      // Keep only a short tail — Apple `container logs` has no `--tail` flag, so trim here.
      return out.split('\n').slice(-50).join('\n')
    } catch {
      return ''
    }
  }

  async remove(exec: ContainerExec, containerId: string): Promise<void> {
    await exec(['delete', '--force', containerId]).catch(() => undefined)
  }

  async removeRun(exec: ContainerExec, runId: string): Promise<void> {
    await this.remove(exec, runName(runId))
  }

  async reapExited(exec: ContainerExec): Promise<number> {
    // Reap only managed containers in a recognised TERMINAL state — never one whose status
    // we can't parse, which could still be running (mirrors the Docker adapter's precise
    // `status=exited` filter). Address by the assigned name when present (always a valid
    // handle), else the id.
    const rows = parseList((await exec(['list', '--all', '--format', 'json'])).stdout).filter(
      (r) => isManaged(r) && TERMINAL_STATUSES.has(r.status),
    )
    if (rows.length) {
      await exec(['delete', '--force', ...rows.map((r) => r.name ?? r.id)]).catch(() => undefined)
    }
    return rows.length
  }

  /** Apple `container` doesn't support the warm pool (see capabilities.pooling=false). */
  async listPoolMembers(): Promise<string[]> {
    return []
  }
}
