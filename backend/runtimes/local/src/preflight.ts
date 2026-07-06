import { execFile } from 'node:child_process'
import { readFile, stat, statfs } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PreflightHostProbes, PreflightProbeOutcome } from '@cat-factory/kernel'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 10_000
const GIB = 1024 ** 3

// The local-mode host implementation of the kernel `PreflightHostProbes` seam: read the host's
// Docker daemon / filesystem / network / trust store to answer a recipe's machine-prerequisite
// checks. This is the ONLY place preflights touch `node:*` (the integrations `PreflightService`
// stays runtime-neutral). Every probe is normalized to never throw — a probe error is a `fail`
// outcome, so the service always gets a verdict. Wired ONLY on the local facade (a host daemon);
// on the Worker / plain Node the preflight service isn't built at all.

export interface DockerPreflightProbesOptions {
  /** The docker-family CLI binary (default `docker`; honours `LOCAL_DOCKER_BINARY`). */
  binary?: string
  /**
   * Fallback volume whose free space `disk-space` measures when Docker's own data root isn't
   * host-readable (Docker Desktop keeps it inside a VM). Default the OS temp dir — the host scratch
   * where the checkout + env files are written.
   */
  diskPath?: string
  /** Path to docker's `config.json` (default `~/.docker/config.json`); injectable for tests. */
  dockerConfigPath?: string
}

const pass = (detail?: string): PreflightProbeOutcome => ({
  status: 'pass',
  ...(detail ? { detail } : {}),
})
const fail = (detail: string): PreflightProbeOutcome => ({ status: 'fail', detail })
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`

/** The host's hosts file path (Windows vs POSIX). */
function hostsFilePath(): string {
  return process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    : '/etc/hosts'
}

/** Normalize a registry ref for auth lookup: drop the scheme + any trailing path/slash. */
function normalizeRegistry(registry: string): string {
  return registry
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
}

export function createDockerPreflightProbes(
  opts: DockerPreflightProbesOptions = {},
): PreflightHostProbes {
  const binary = opts.binary?.trim() || 'docker'
  const diskPath = opts.diskPath || tmpdir()
  const dockerConfigPath = opts.dockerConfigPath || join(homedir(), '.docker', 'config.json')

  return {
    async dockerDaemon() {
      try {
        const { stdout } = await execFileAsync(binary, ['info', '--format', '{{.ServerVersion}}'], {
          timeout: PROBE_TIMEOUT_MS,
        })
        const version = stdout.trim()
        return pass(version ? `Docker ${version}` : 'daemon reachable')
      } catch (err) {
        return fail(errMessage(err) || 'Docker daemon not reachable')
      }
    },

    async diskSpace(minBytes) {
      // Prefer Docker's data root (where images/volumes actually land) when it's host-readable — on
      // native Linux that's the real constraint. On Docker Desktop the root lives inside a VM and
      // isn't host-visible, so we fall back to the configured scratch path (the host working dir
      // where the checkout + env files are written).
      const dataRoot = await dockerInfoField(binary, '{{.DockerRootDir}}')
      const candidates = [dataRoot, diskPath].filter((p): p is string => !!p)
      for (const target of candidates) {
        try {
          const { bavail, bsize } = await statfs(target)
          const free = bavail * bsize
          return free >= minBytes
            ? pass(`${gib(free)} free on ${target}`)
            : fail(`${gib(free)} free on ${target} (< ${gib(minBytes)} required)`)
        } catch {
          // Not host-readable (a Docker Desktop VM path) — try the next candidate.
        }
      }
      return fail(`could not read free disk (checked ${candidates.join(', ')})`)
    },

    async memory(minBytes) {
      // Prefer the Docker engine's view of total memory — on Docker Desktop (macOS/Windows)
      // containers are bounded by the VM's allocation, NOT the host's physical RAM, so
      // `os.totalmem()` would false-pass a machine with plenty of host RAM but a small Docker
      // allocation. Fall back to the host total when the daemon isn't reachable.
      const daemonMem = await dockerInfoNumber(binary, '{{.MemTotal}}')
      const total = daemonMem ?? totalmem()
      const source = daemonMem !== null ? 'Docker' : 'host'
      return total >= minBytes
        ? pass(`${gib(total)} ${source} total`)
        : fail(`${gib(total)} ${source} total (< ${gib(minBytes)} required)`)
    },

    async registryAuth(registry) {
      const wanted = normalizeRegistry(registry)
      try {
        const raw = await readFile(dockerConfigPath, 'utf8')
        const config = JSON.parse(raw) as {
          auths?: Record<string, unknown>
          credHelpers?: Record<string, unknown>
        }
        // `docker login <registry>` writes a per-registry `auths` entry even when a credential
        // STORE/HELPER keeps the secret out of the file (the entry's `auth` is then empty), so a
        // per-registry `auths` or `credHelpers` key is the reliable signal — we CHECK for it, never
        // read the secret. We deliberately do NOT treat a global `credsStore` as proof: it only
        // means docker CAN present creds for SOME registry, not that THIS one is logged in, and
        // would false-pass every check on a stock Docker Desktop (which sets `credsStore: "desktop"`),
        // defeating the whole "detect an expired ECR login before a 40-image pull" point.
        const authed =
          Object.keys(config.auths ?? {}).some((k) => normalizeRegistry(k) === wanted) ||
          Object.keys(config.credHelpers ?? {}).some((k) => normalizeRegistry(k) === wanted)
        return authed
          ? pass(`credential present for ${wanted}`)
          : fail(`no docker login for ${wanted}`)
      } catch {
        // No config.json (or unreadable) ⇒ never logged in anywhere.
        return fail(`no docker login for ${wanted}`)
      }
    },

    tcpReachable(host, port) {
      return new Promise<PreflightProbeOutcome>((resolve) => {
        let settled = false
        const done = (outcome: PreflightProbeOutcome) => {
          if (settled) return
          settled = true
          socket.destroy()
          resolve(outcome)
        }
        const socket = createConnection({ host, port })
        socket.setTimeout(PROBE_TIMEOUT_MS)
        socket.once('connect', () => done(pass(`${host}:${port} reachable`)))
        socket.once('timeout', () => done(fail(`${host}:${port} timed out`)))
        socket.once('error', (err) => done(fail(`${host}:${port}: ${err.message}`)))
      })
    },

    async httpReachable(url, probeOpts) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
        let body = ''
        if (probeOpts?.expectBodyContains) body = await res.text()
        else await res.body?.cancel()
        const statusOk = probeOpts?.expectStatus ? res.status === probeOpts.expectStatus : res.ok
        const bodyOk = !probeOpts?.expectBodyContains || body.includes(probeOpts.expectBodyContains)
        return statusOk && bodyOk ? pass(`HTTP ${res.status}`) : fail(`HTTP ${res.status}`)
      } catch (err) {
        return fail(errMessage(err) || 'request failed')
      }
    },

    async mkcertCa() {
      try {
        const { stdout } = await execFileAsync('mkcert', ['-CAROOT'], { timeout: PROBE_TIMEOUT_MS })
        const caRoot = stdout.trim()
        if (!caRoot) return fail('mkcert did not report a CA root')
        await stat(join(caRoot, 'rootCA.pem'))
        return pass('mkcert CA installed')
      } catch (err) {
        return fail(errMessage(err) || 'mkcert CA not found')
      }
    },

    async hostsEntries(hostnames) {
      try {
        const text = await readFile(hostsFilePath(), 'utf8')
        // Match each hostname as a whole token (word-bounded) so `acme.local` doesn't spuriously
        // match `foo-acme.local` and a commented-out line still counts as absent handling is left to
        // the operator (a `#`-prefixed line still contains the token — we check presence, not intent).
        const missing = hostnames.filter(
          (h) => !new RegExp(`(^|\\s)${escapeRegExp(h)}(\\s|$)`, 'm').test(text),
        )
        return missing.length === 0
          ? pass('all hosts entries present')
          : fail(`missing hosts entries: ${missing.join(', ')}`)
      } catch (err) {
        return fail(`could not read the hosts file: ${errMessage(err)}`)
      }
    },

    async envSecretsMarker(file, marker) {
      try {
        const text = await readFile(file, 'utf8')
        return text.includes(marker)
          ? pass('secrets marker present')
          : fail(`marker '${marker}' not found in ${file}`)
      } catch (err) {
        return fail(`could not read ${file}: ${errMessage(err)}`)
      }
    },
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Run `docker info --format <fmt>` and return the trimmed value, or null on any error / empty. */
async function dockerInfoField(binary: string, format: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ['info', '--format', format], {
      timeout: PROBE_TIMEOUT_MS,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** As {@link dockerInfoField}, coerced to a positive finite number (else null). */
async function dockerInfoNumber(binary: string, format: string): Promise<number | null> {
  const raw = await dockerInfoField(binary, format)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
