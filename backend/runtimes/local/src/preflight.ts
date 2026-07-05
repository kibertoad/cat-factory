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
  /** Volume whose free space `disk-space` measures (default the OS temp dir — where compose scratch lives). */
  diskPath?: string
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
      try {
        const { bavail, bsize } = await statfs(diskPath)
        const free = bavail * bsize
        return free >= minBytes
          ? pass(`${gib(free)} free`)
          : fail(`${gib(free)} free (< ${gib(minBytes)} required)`)
      } catch (err) {
        return fail(`could not read free disk on ${diskPath}: ${errMessage(err)}`)
      }
    },

    async memory(minBytes) {
      const total = totalmem()
      return total >= minBytes
        ? pass(`${gib(total)} total`)
        : fail(`${gib(total)} total (< ${gib(minBytes)} required)`)
    },

    async registryAuth(registry) {
      const wanted = normalizeRegistry(registry)
      try {
        const raw = await readFile(join(homedir(), '.docker', 'config.json'), 'utf8')
        const config = JSON.parse(raw) as {
          auths?: Record<string, unknown>
          credHelpers?: Record<string, unknown>
          credsStore?: unknown
        }
        // A stored auth entry, a per-registry credential helper, or a global credential store all
        // mean docker can present credentials for this registry — we CHECK for one, never read it.
        const authed =
          Object.keys(config.auths ?? {}).some((k) => normalizeRegistry(k) === wanted) ||
          Object.keys(config.credHelpers ?? {}).some((k) => normalizeRegistry(k) === wanted) ||
          typeof config.credsStore === 'string'
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
