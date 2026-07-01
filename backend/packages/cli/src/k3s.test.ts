import { describe, expect, it } from 'vitest'
import { type CliOptions } from './args.js'
import { COMMAND_NOT_FOUND, type HostShell, type ShellResult } from './host-shell.js'
import { type Io } from './io.js'
import { K3S_INSTALL_COMMAND, setupK3s } from './k3s.js'

/** A fake shell keyed by `` `${cmd} ${args.join(' ')}` ``; unmapped ⇒ command-not-found. */
function scriptShell(map: Record<string, Partial<ShellResult>> = {}): HostShell {
  return {
    run(cmd, args) {
      const hit = map[[cmd, ...args].join(' ')]
      return Promise.resolve<ShellResult>(
        hit
          ? { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
          : { code: COMMAND_NOT_FOUND, stdout: '', stderr: 'not found' },
      )
    },
  }
}

/** Scripted Io that records every info line and returns queued selects. */
function captureIo(selects: string[] = []): Io & { lines: string[] } {
  const lines: string[] = []
  const sel = [...selects]
  return {
    lines,
    info: (m) => {
      lines.push(m)
    },
    warn: (m) => {
      lines.push(m)
    },
    question: (_p, d) => Promise.resolve(d ?? ''),
    select: <T extends string>(_p: string, _o: readonly { value: T }[], d: T) =>
      Promise.resolve((sel.shift() as T | undefined) ?? d),
    secret: () => Promise.resolve(''),
    confirm: (_p, d) => Promise.resolve(d),
    openBrowser: () => Promise.resolve(),
  }
}

function opts(extra: Partial<CliOptions>): CliOptions {
  return { command: 'k3s', noOpen: false, yes: false, force: false, ...extra }
}

const REACHABLE = {
  'kubectl version --output=json --request-timeout=3s': {
    code: 0,
    stdout: JSON.stringify({ serverVersion: { gitVersion: 'v1.30.0' } }),
  },
  'kubectl config current-context': { code: 0, stdout: 'k3d-cat-factory' },
}

/** The provisioning commands (RBAC apply, token read, apiserver read) every wiring path issues. */
const TOKEN_B64 = Buffer.from('tok-abc').toString('base64')

/**
 * Build the provisioning-command map. Create paths carry an explicit `--context`; the reuse path
 * (default `context: undefined`) operates on the current context.
 */
function provisionMap(context?: string): Record<string, Partial<ShellResult>> {
  const ctx = context ? ` --context ${context}` : ''
  return {
    [`kubectl apply -f -${ctx}`]: { code: 0, stdout: 'applied' },
    [`kubectl -n cat-factory get secret cat-factory-token -o jsonpath={.data.token}${ctx}`]: {
      code: 0,
      stdout: TOKEN_B64,
    },
    [`kubectl config view --minify -o jsonpath={.clusters[0].cluster.server}${ctx}`]: {
      code: 0,
      stdout: 'https://127.0.0.1:6443',
    },
  }
}

/** The reuse-path provisioning commands (current context, no `--context` suffix). */
const PROVISION = provisionMap()

describe('setupK3s', () => {
  it('in --yes mode provisions the recommended offer (reuse existing cluster)', async () => {
    const io = captureIo()
    const { state, chosen, connection } = await setupK3s(opts({ yes: true }), {
      io,
      shell: scriptShell({ ...REACHABLE, ...PROVISION }),
    })
    expect(state.detections.reachableCluster).toBe(true)
    expect(chosen).toBe('use-existing')
    expect(connection).toEqual({
      engine: 'local-k3s',
      clusterName: undefined,
      apiServerUrl: 'https://127.0.0.1:6443',
      apiToken: 'tok-abc',
      insecureSkipTlsVerify: true,
    })
    const out = io.lines.join('\n')
    expect(out).toContain('reachable cluster')
    expect(out).toContain('https://127.0.0.1:6443')
    expect(out).toContain('tok-abc')
  })

  it('prints the k3s install command (never runs it) when nothing usable is present', async () => {
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true }), {
      io,
      shell: scriptShell({}),
    })
    expect(chosen).toBe('install-k3s')
    expect(connection).toBeUndefined()
    const out = io.lines.join('\n')
    expect(out).toContain(K3S_INSTALL_COMMAND)
    expect(out).toContain('needs sudo')
  })

  it('honors an interactive selection over the recommendation', async () => {
    // Reachable cluster ⇒ recommended is use-existing; user instead picks install-k3s.
    const io = captureIo(['install-k3s'])
    const { chosen } = await setupK3s(opts({}), { io, shell: scriptShell(REACHABLE) })
    expect(chosen).toBe('install-k3s')
  })

  it('reports the findings before doing anything', async () => {
    const io = captureIo()
    await setupK3s(opts({ yes: true }), { io, shell: scriptShell({}) })
    const out = io.lines.join('\n')
    expect(out).toContain('Detected:')
  })

  it('creates + wires a k3d cluster with the chosen name', async () => {
    const shell = scriptShell({
      'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
      'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
      'k3d cluster create my-cluster --api-port 6443': { code: 0 },
      ...provisionMap('k3d-my-cluster'),
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true, clusterName: 'my-cluster' }), {
      io,
      shell,
    })
    expect(chosen).toBe('create-k3d')
    expect(connection?.clusterName).toBe('my-cluster')
    expect(connection?.apiToken).toBe('tok-abc')
    expect(io.lines.join('\n')).toContain('my-cluster')
  })

  it('honors --runtime kind and wires the kind cluster', async () => {
    const shell = scriptShell({
      'kind version': { code: 0, stdout: 'kind v0.23.0' },
      'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
      'kind create cluster --name kd': { code: 0 },
      ...provisionMap('kind-kd'),
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(
      opts({ yes: true, k3sRuntime: 'kind', clusterName: 'kd' }),
      { io, shell },
    )
    expect(chosen).toBe('create-kind')
    expect(connection?.clusterName).toBe('kd')
  })

  it('guides an already-installed k3s to start (not re-install)', async () => {
    const shell = scriptShell({ 'k3s --version': { code: 0, stdout: 'k3s version v1.30.0+k3s1' } })
    const io = captureIo()
    const { chosen } = await setupK3s(opts({ yes: true }), { io, shell })
    expect(chosen).toBe('install-k3s')
    const out = io.lines.join('\n')
    expect(out).toContain('already installed')
    expect(out).not.toContain(K3S_INSTALL_COMMAND)
  })

  it('reuses (does not recreate) a k3d cluster whose name already exists', async () => {
    const shell = scriptShell({
      'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
      'k3d cluster list --output json': { code: 0, stdout: '[{"name":"dupe"}]' },
      'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
      // NOTE: no `k3d cluster create` mapping — reuse must not attempt to create it.
      ...provisionMap('k3d-dupe'),
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true, clusterName: 'dupe' }), {
      io,
      shell,
    })
    expect(chosen).toBe('create-k3d')
    expect(connection?.apiServerUrl).toBe('https://127.0.0.1:6443')
    expect(io.lines.join('\n')).toContain('Reusing the existing k3d cluster')
  })

  it('reports (does not throw) when a provisioning command fails', async () => {
    // Reachable cluster ⇒ use-existing path; the apiserver read succeeds but the RBAC apply fails.
    const shell = scriptShell({
      ...REACHABLE,
      ...PROVISION,
      'kubectl apply -f -': { code: 1, stderr: 'forbidden' },
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true }), { io, shell })
    expect(chosen).toBe('use-existing')
    expect(connection).toBeUndefined()
    expect(io.lines.join('\n')).toContain('forbidden')
  })

  it('refuses to auto-provision a non-local reachable cluster in --yes mode', async () => {
    const shell = scriptShell({
      'kubectl version --output=json --request-timeout=3s': {
        code: 0,
        stdout: JSON.stringify({ serverVersion: { gitVersion: 'v1.30.0' } }),
      },
      'kubectl config current-context': { code: 0, stdout: 'prod' },
      'kubectl config view --minify -o jsonpath={.clusters[0].cluster.server}': {
        code: 0,
        stdout: 'https://api.k8s.example.com:6443',
      },
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true }), { io, shell })
    expect(chosen).toBe('use-existing')
    expect(connection).toBeUndefined()
    expect(io.lines.join('\n')).toContain('does not look like a local cluster')
  })

  it('aborts a provisioning path when the user declines a confirm', async () => {
    const io: Io & { lines: string[] } = { ...captureIo(), confirm: () => Promise.resolve(false) }
    const { connection } = await setupK3s(opts({ clusterName: 'dupe' }), {
      io,
      shell: scriptShell({
        'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
        'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
        ...PROVISION,
      }),
    })
    expect(connection).toBeUndefined()
    expect(io.lines.join('\n')).toContain('Cancelled')
  })
})
