import { describe, expect, it } from 'vitest'
import { type CliOptions } from './args.js'
import { COMMAND_NOT_FOUND, type HostShell, type ShellResult } from './host-shell.js'
import { type Io } from './io.js'
import { classifyHost, type HostDetections } from './k3s-probe.js'
import {
  applyRbacCommand,
  CAT_FACTORY_NAMESPACE,
  contextName,
  decodeToken,
  k3dCreateCommand,
  kindCreateCommand,
  ProvisionError,
  provisionCluster,
  RBAC_MANIFEST,
  readApiServerCommand,
  readTokenCommand,
  type ResolvedConnection,
} from './k3s-provision.js'

/** A fake shell that records every invocation and answers from a map (unmapped ⇒ not-found). */
function recordingShell(map: Record<string, Partial<ShellResult>> = {}): HostShell & {
  calls: { cmd: string; args: string[]; input?: string }[]
} {
  const calls: { cmd: string; args: string[]; input?: string }[] = []
  return {
    calls,
    run(cmd, args, o) {
      calls.push({ cmd, args, input: o?.input })
      const hit = map[[cmd, ...args].join(' ')]
      return Promise.resolve<ShellResult>(
        hit
          ? { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
          : { code: COMMAND_NOT_FOUND, stdout: '', stderr: 'not found' },
      )
    },
  }
}

/** A silent Io that auto-confirms — provisioning-executor tests drive confirms via `--yes`/deps. */
function silentIo(confirmAnswer = true): Io {
  return {
    info: () => {},
    warn: () => {},
    question: (_p, d) => Promise.resolve(d ?? ''),
    select: <T extends string>(_p: string, _o: readonly { value: T }[], d: T) => Promise.resolve(d),
    secret: () => Promise.resolve(''),
    confirm: () => Promise.resolve(confirmAnswer),
    openBrowser: () => Promise.resolve(),
  }
}

function detections(over: Partial<HostDetections> = {}): HostDetections {
  return {
    kubectl: { installed: true },
    k3d: { installed: true },
    kind: { installed: true },
    k3s: { installed: false },
    docker: { installed: true, running: true },
    reachableCluster: false,
    k3dClusters: [],
    kindClusters: [],
    ...over,
  }
}

function opts(extra: Partial<CliOptions> = {}): CliOptions {
  return { command: 'k3s', noOpen: false, yes: true, force: false, ...extra }
}

const TOKEN_B64 = Buffer.from('sa-token-value').toString('base64')
const PROVISION = {
  'kubectl apply -f -': { code: 0, stdout: 'applied' },
  'kubectl -n cat-factory get secret cat-factory-token -o jsonpath={.data.token}': {
    code: 0,
    stdout: TOKEN_B64,
  },
  'kubectl config view --minify -o jsonpath={.clusters[0].cluster.server}': {
    code: 0,
    stdout: 'https://127.0.0.1:6443\n',
  },
}

describe('pure planners', () => {
  it('builds the k3d/kind create + context commands', () => {
    expect(k3dCreateCommand('c')).toEqual({
      cmd: 'k3d',
      args: ['cluster', 'create', 'c', '--api-port', '6443'],
    })
    expect(kindCreateCommand('c')).toEqual({
      cmd: 'kind',
      args: ['create', 'cluster', '--name', 'c'],
    })
    expect(contextName('k3d', 'c')).toBe('k3d-c')
    expect(contextName('kind', 'c')).toBe('kind-c')
  })

  it('feeds the RBAC manifest on stdin and never binds cluster-admin', () => {
    const apply = applyRbacCommand()
    expect(apply.args).toEqual(['apply', '-f', '-'])
    expect(apply.input).toBe(RBAC_MANIFEST)
    expect(RBAC_MANIFEST).not.toContain('cluster-admin')
    expect(RBAC_MANIFEST).toContain(`namespace: ${CAT_FACTORY_NAMESPACE}`)
  })

  it('reads the token + apiserver via jsonpath and decodes base64', () => {
    expect(readTokenCommand().args).toContain('jsonpath={.data.token}')
    expect(readApiServerCommand().args).toContain('jsonpath={.clusters[0].cluster.server}')
    expect(decodeToken(TOKEN_B64)).toBe('sa-token-value')
    expect(decodeToken('')).toBe('')
  })
})

describe('provisionCluster', () => {
  const deps = (shell: HostShell, io: Io = silentIo()) => ({
    shell,
    io,
    sleep: () => Promise.resolve(),
  })

  it('reuse-existing: applies RBAC + reads token/URL, no cluster create', async () => {
    const shell = recordingShell(PROVISION)
    const state = classifyHost(detections({ reachableCluster: true }))
    const conn = await provisionCluster('use-existing', state, opts(), deps(shell))
    expect(conn).toEqual<ResolvedConnection>({
      engine: 'local-k3s',
      clusterName: undefined,
      apiServerUrl: 'https://127.0.0.1:6443',
      apiToken: 'sa-token-value',
      insecureSkipTlsVerify: true,
    })
    expect(shell.calls.some((c) => c.cmd === 'k3d')).toBe(false)
    expect(shell.calls.some((c) => c.args.join(' ').includes('apply -f -'))).toBe(true)
  })

  it('create-k3d: creates the cluster, switches context, then provisions', async () => {
    const shell = recordingShell({
      'k3d cluster create cat-factory --api-port 6443': { code: 0 },
      'kubectl config use-context k3d-cat-factory': { code: 0 },
      ...PROVISION,
    })
    const conn = await provisionCluster(
      'create-k3d',
      classifyHost(detections()),
      opts(),
      deps(shell),
    )
    expect(conn.clusterName).toBe('cat-factory')
    const seq = shell.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)
    expect(seq).toContain('k3d cluster create cat-factory --api-port 6443')
    expect(seq).toContain('kubectl config use-context k3d-cat-factory')
  })

  it('create-k3d: reuses an existing cluster (no create call)', async () => {
    const shell = recordingShell({
      'kubectl config use-context k3d-cat-factory': { code: 0 },
      ...PROVISION,
    })
    const state = classifyHost(detections({ k3dClusters: ['cat-factory'] }))
    await provisionCluster('create-k3d', state, opts(), deps(shell))
    expect(shell.calls.some((c) => c.args.includes('create'))).toBe(false)
  })

  it('retries the token read until the Secret populates', async () => {
    let n = 0
    const shell: HostShell = {
      run(cmd, args) {
        const key = [cmd, ...args].join(' ')
        if (key.includes('get secret')) {
          n++
          return Promise.resolve({ code: 0, stdout: n < 3 ? '' : TOKEN_B64, stderr: '' })
        }
        const hit = (PROVISION as Record<string, Partial<ShellResult>>)[key]
        return Promise.resolve({ code: hit?.code ?? 0, stdout: hit?.stdout ?? '', stderr: '' })
      },
    }
    const conn = await provisionCluster(
      'use-existing',
      classifyHost(detections({ reachableCluster: true })),
      opts(),
      deps(shell),
    )
    expect(conn.apiToken).toBe('sa-token-value')
    expect(n).toBe(3)
  })

  it('throws ProvisionError with the stderr when a command fails', async () => {
    const shell = recordingShell({ 'kubectl apply -f -': { code: 1, stderr: 'forbidden: rbac' } })
    await expect(
      provisionCluster(
        'use-existing',
        classifyHost(detections({ reachableCluster: true })),
        opts(),
        deps(shell),
      ),
    ).rejects.toThrow(/forbidden: rbac/)
  })

  it('throws ProvisionError when a confirm is declined (interactive)', async () => {
    const shell = recordingShell(PROVISION)
    await expect(
      provisionCluster(
        'create-k3d',
        classifyHost(detections()),
        opts({ yes: false }),
        deps(shell, silentIo(false)),
      ),
    ).rejects.toThrow(ProvisionError)
    // Declined before any create command ran.
    expect(shell.calls.some((c) => c.cmd === 'k3d')).toBe(false)
  })
})
